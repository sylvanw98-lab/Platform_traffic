const html = '__DASHBOARD__';
const hourMs = 3600000;
const offset = 8 * hourMs;
const metrics = ['impressions', 'likes', 'comments'];
const spreadsheet = 'WCjSs5eMjh7WY4tnvLkcqufanpd';
const feishu = 'https://open.feishu.cn/open-apis';
const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } });
const hourOf = (time) => Math.floor(time / hourMs) * hourMs;

async function readJson(url, options, provider) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || (provider === '飞书' && data.code !== 0)) {
    const retry = response.headers.get('Retry-After');
    const reset = response.headers.get('x-rate-limit-reset');
    const now = Date.now();
    const next = retry
      ? (/^\d+$/.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry))
      : Number(reset) * 1000;
    throw Object.assign(new Error(provider + '请求失败（' + (data?.code || response.status) + '）'),
      { status: response.status, retryAt: response.status === 429 ? Math.max(now + 60000, next || now + hourMs) : 0 });
  }
  return data;
}

function postFromRow(row) {
  const cell = row[4];
  const candidates = (Array.isArray(cell) ? cell : [cell]).flatMap(item =>
    typeof item === 'string' ? [item] : [item?.link, item?.url, item?.text]);
  return candidates.flatMap(value => {
    const link = typeof value === 'string' && value.match(/https?:\/\/[^\s"<>]+/i)?.[0];
    if (!link) return [];
    const url = URL.canParse(link) && new URL(link);
    if (!url || url.username || url.password) return [];
    const x = /^(?:www\.|mobile\.)?(?:x|twitter)\.com$/i.test(url.hostname);
    const id = x && url.pathname.match(/^\/(?:i\/web|[\w]+)\/status\/(\d+)(?:\/|$)/)?.[1];
    return [{
      id: id ? 'x:' + id : 'url:' + url.origin + url.pathname + url.search,
      platform: id ? 'X' : url.hostname,
      account: typeof row[1] === 'string' && row[1].trim() || (id ? url.pathname.split('/')[1] : ''),
      url: id ? 'https://x.com/i/web/status/' + id : url.origin + url.pathname + url.search,
      title: typeof row[3] === 'string' ? row[3].trim() : '',
    }];
  });
}

async function syncPosts(env, hour) {
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('待配置飞书应用凭据');
  const token = await readJson(feishu + '/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
  }, '飞书');
  const options = { headers: { Authorization: 'Bearer ' + token.tenant_access_token } };
  const root = '/spreadsheets/' + spreadsheet;
  const metadata = await readJson(feishu + '/sheets/v3' + root + '/sheets/query', options, '飞书');
  const sheets = metadata.data?.sheets || [];
  const sheet = sheets.find(item => env.FEISHU_SHEET_ID ? item.sheet_id === env.FEISHU_SHEET_ID : item.title === '发布记录');
  if (!sheet) throw new Error('未找到发布记录工作表');
  const posts = new Map();
  const size = sheet.grid_properties?.row_count;
  if (!Number.isInteger(size) || size < 1) throw new Error('无法读取工作表行数');
  for (let start = 2; start <= size; start += 500) {
    const range = sheet.sheet_id + '!B' + start + ':F' + Math.min(size, start + 499);
    const result = await readJson(feishu + '/sheets/v2' + root + '/values/' + encodeURIComponent(range) +
      '?valueRenderOption=UnformattedValue', options, '飞书');
    const rows = result.data?.valueRange?.values;
    if (rows != null && !Array.isArray(rows)) throw new Error('飞书返回的单元格格式无效');
    for (const row of rows || []) {
      for (const post of postFromRow(row || [])) if (!posts.has(post.id)) posts.set(post.id, post);
    }
  }
  const statements = [env.DB.prepare('UPDATE posts SET active=0 WHERE active=1')];
  for (const post of posts.values()) {
    statements.push(env.DB.prepare(`INSERT INTO posts VALUES (?,?,?,?,?,1,?)
      ON CONFLICT(id) DO UPDATE SET platform=excluded.platform, account=excluded.account,
      url=excluded.url, title=excluded.title, active=1`)
      .bind(post.id, post.platform, post.account, post.url, post.title, hour));
  }
  await env.DB.batch(statements);
  return posts.size;
}

async function getSetting(db, key) {
  const row = await db.prepare('SELECT value FROM settings WHERE key=?').bind(key).first();
  return row ? JSON.parse(row.value) : null;
}
async function putSetting(db, key, value) {
  await db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .bind(key, JSON.stringify(value)).run();
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
async function collect(env) {
  const now = Date.now();
  const hour = hourOf(now);
  const db = env.DB;
  const previous = await getSetting(db, 'run') || {};
  if (previous.hour === hour && previous.syncIssue === null && previous.collectionIssue === null) return previous;
  let syncIssue = null;
  let syncAt = previous.syncAt || null;
  try {
    await syncPosts(env, hour);
    syncAt = Date.now();
  } catch (error) {
    syncIssue = safeIssue(error, '飞书同步失败');
  }

  const state = { hour, attemptedAt: now, syncAt, syncIssue, collectionIssue: null, retryAt: null };
  const { results: posts } = await db.prepare(`SELECT p.id FROM posts p
    WHERE p.active=1 AND p.platform='X' AND NOT EXISTS
    (SELECT 1 FROM snapshots s WHERE s.post_id=p.id AND s.hour=?) ORDER BY p.id`).bind(hour).all();
  if (!env.X_BEARER_TOKEN) {
    state.collectionIssue = '待配置 X API 凭据';
  } else if (previous.retryAt > now) {
    state.collectionIssue = previous.collectionIssue;
    state.retryAt = previous.retryAt;
  } else {
    for (let i = 0; i < posts.length; i += 100) {
      const ids = posts.slice(i, i + 100).map(post => post.id.slice(2));
      try {
        const result = await readJson('https://api.x.com/2/tweets?ids=' + ids.join(',') + '&tweet.fields=public_metrics,created_at', {
          headers: { Authorization: 'Bearer ' + env.X_BEARER_TOKEN },
        }, 'X');
        const requested = new Set(ids);
        const writes = (result.data || []).filter(post => requested.has(post.id)).map(post => {
          const m = post.public_metrics || {};
          return db.prepare('INSERT OR IGNORE INTO snapshots VALUES (?,?,?,?,?,?)')
            .bind('x:' + post.id, hour, Date.now(), count(m.impression_count), count(m.like_count), count(m.reply_count));
        });
        if (writes.length) await db.batch(writes);
        if (writes.length < ids.length) state.collectionIssue = '部分 X 帖子暂时无法读取';
      } catch (error) {
        state.collectionIssue = safeIssue(error, 'X 指标采集失败');
        if (error.retryAt) state.retryAt = error.retryAt;
        break;
      }
    }
  }
  state.collected = await db.prepare('SELECT count(*) AS n FROM snapshots WHERE hour=?').bind(hour).first('n');
  await putSetting(db, 'run', state);
  return state;
}

function safeIssue(error, fallback) {
  return /^(?:飞书请求失败|X请求失败|待配置|未找到|无法读取工作表|飞书返回)/.test(error.message)
    ? error.message : fallback;
}

function floorPeriod(time, unit) {
  if (unit === 'hour') return hourOf(time);
  const date = new Date(time + offset);
  date.setUTCHours(0, 0, 0, 0);
  if (unit === 'month' || unit === 'year') date.setUTCDate(1);
  if (unit === 'year') date.setUTCMonth(0);
  return +date - offset;
}
function nextPeriod(time, unit) {
  if (unit === 'hour') return time + hourMs;
  if (unit === 'day') return time + 24 * hourMs;
  const date = new Date(time + offset);
  if (unit === 'month') date.setUTCMonth(date.getUTCMonth() + 1);
  else date.setUTCFullYear(date.getUTCFullYear() + 1);
  return +date - offset;
}
function parseDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return NaN;
  const time = Date.parse(value + 'T00:00:00+08:00');
  return Number.isFinite(time) && new Date(time + offset).toISOString().slice(0, 10) === value ? time : NaN;
}

async function dashboard(db, query) {
  const unit = ['hour', 'day', 'month', 'year'].includes(query.get('unit')) ? query.get('unit') : 'day';
  const now = hourOf(Date.now());
  const starts = { hour: now - 24 * hourMs, day: now - 29 * 24 * hourMs, month: now - 335 * 24 * hourMs, year: now - 4 * 365 * 24 * hourMs };
  const from = parseDay(query.get('from'));
  const to = parseDay(query.get('to'));
  const start = Number.isFinite(from) ? from : floorPeriod(starts[unit], unit);
  const end = Math.min(Number.isFinite(to) ? to + 24 * hourMs : now, now);
  const windows = [];
  for (let left = start; left < end;) {
    if (windows.length >= 744) return json({ error: '时间范围过长，请缩短范围或切换时间粒度' }, 400);
    const right = Math.min(end, nextPeriod(floorPeriod(left, unit), unit));
    windows.push({ start: left, end: right });
    left = right;
  }
  const platform = query.get('platform') || '';
  const account = query.get('account') || '';
  const filter = 'p.active=1 AND (?=\'\' OR p.platform=?) AND (?=\'\' OR p.account=?)';
  const args = [platform, platform, account, account];
  const [{ results: posts }, { results: options }, run] = await Promise.all([
    db.prepare(`SELECT p.*,s.impressions,s.likes,s.comments,s.captured_at FROM posts p LEFT JOIN snapshots s
      ON s.post_id=p.id AND s.hour=(SELECT max(t.hour) FROM snapshots t WHERE t.post_id=p.id AND t.hour<=?)
      WHERE ${filter} ORDER BY s.impressions DESC, p.id`).bind(end, ...args).all(),
    db.prepare('SELECT DISTINCT platform,account FROM posts WHERE active=1 ORDER BY platform,account').all(),
    getSetting(db, 'run'),
  ]);
  const trend = [];
  for (let i = 0; i < windows.length; i += 30) {
    const batch = windows.slice(i, i + 30);
    const rows = batch.map(() => '(?,?)').join(',');
    const select = metrics.map(metric => `sum(b.${metric}-a.${metric}) AS ${metric},
      count(b.${metric}-a.${metric}) AS ${metric}_coverage`).join(',');
    const { results } = await db.prepare(`WITH windows(start,end) AS (VALUES ${rows})
      SELECT w.start,w.end,count(p.id) AS expected,${select} FROM windows w
      LEFT JOIN posts p ON p.first_hour<=w.end AND ${filter}
      LEFT JOIN snapshots a ON a.post_id=p.id AND a.hour=w.start
      LEFT JOIN snapshots b ON b.post_id=p.id AND b.hour=w.end
      GROUP BY w.start,w.end ORDER BY w.start`)
      .bind(...batch.flatMap(period => [period.start, period.end]), ...args).all();
    trend.push(...results);
  }
  return json({ posts, options, run, trend, unit, start, end });
}

async function mcp(request, env) {
  const rpc = await request.json();
  const reply = (result) => json({ jsonrpc: '2.0', id: rpc.id, result });
  if (rpc.method === 'server/discover') {
    return reply({ supportedVersions: ['2026-07-28'], capabilities: { tools: {} } });
  }
  if (rpc.method === 'tools/list') {
    return reply({ tools: [{ name: 'collect_metrics', description: '同步飞书发布链接并采集本小时指标', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] });
  }
  if (rpc.method === 'tools/call' && rpc.params?.name === 'collect_metrics') {
    const email = request.headers.get('oai-authenticated-user-email')?.toLowerCase();
    if (!env.COLLECT_OWNER_EMAIL || email !== env.COLLECT_OWNER_EMAIL.toLowerCase()) {
      return reply({ isError: true, content: [{ type: 'text', text: '采集工具尚未授权给当前账号' }] });
    }
    const run = await collect(env);
    return reply({ isError: Boolean(run.collectionIssue || run.syncIssue), content: [{ type: 'text', text: JSON.stringify(run) }] });
  }
  return json({ jsonrpc: '2.0', id: rpc.id ?? null, error: { code: -32601, message: 'Method not found' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/') {
        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' } });
      }
      if (request.method === 'GET' && url.pathname === '/api/dashboard') return await dashboard(env.DB, url.searchParams);
      if (request.method === 'POST' && url.pathname === '/mcp') return await mcp(request, env);
      if (request.method === 'POST' && url.pathname === '/api/collect') {
        if (!env.COLLECT_TOKEN || request.headers.get('Authorization') !== 'Bearer ' + env.COLLECT_TOKEN) return json({ error: '未授权' }, 403);
        const result = await collect(env);
        return json(result, result.retryAt ? 429 : result.syncIssue || result.collectionIssue ? 503 : 200);
      }
      return json({ error: '页面不存在' }, 404);
    } catch {
      return json({ error: '服务暂时不可用' }, 503);
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(collect(env));
  },
};
