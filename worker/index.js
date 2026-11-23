const html = '__DASHBOARD__';
const platformHtml = '__PLATFORM_DASHBOARD__';
const hourMs = 3600000;
const offset = 8 * hourMs;
const metrics = ['impressions', 'likes', 'comments'];
const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } });
const hourOf = (time) => Math.floor(time / hourMs) * hourMs;

async function readJson(url, options, provider) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
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

const accountFeeds = {
  X: { handle: 'shotpoet', origin: 'https://x.com', prefix: 'x:', postPath: /^\/shotpoet\/status\/(\d+)\/?$/ },
  Instagram: { handle: 'shotpoet_ai', origin: 'https://www.instagram.com', prefix: 'instagram:', postPath: /^\/shotpoet_ai\/(?:p|reel|reels|tv)\/([\w-]+)\/?$/ },
  TikTok: { handle: 'shotpoet_ai', origin: 'https://www.tiktok.com', prefix: 'tiktok:', postPath: /^\/@shotpoet_ai\/(?:video|photo)\/(\d+)\/?$/ },
};

function instagramCode(path) {
  return path.match(/^\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([\w-]+)(?:\/|$)/)?.[1];
}

function accountPost(entry) {
  const feed = accountFeeds[entry.platform];
  if (!Object.hasOwn(accountFeeds, entry.platform) || typeof entry.url !== 'string' || !URL.canParse(entry.url)) return null;
  const url = new URL(entry.url);
  const match = url.origin === feed.origin && url.pathname.match(feed.postPath);
  if (!match || url.username || url.password) return null;
  const id = feed.prefix + match[1];
  if (entry.id !== id) return null;
  return { id, platform: entry.platform, account: feed.handle, url: url.origin + url.pathname, title: capturedTitle(entry) };
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
function snapshot(db) {
  return db.prepare(`INSERT INTO snapshots (post_id,hour,captured_at,impressions,likes,comments,source)
    VALUES (?,?,?,?,?,?,'api') ON CONFLICT (post_id,hour) DO UPDATE SET captured_at=excluded.captured_at,
    impressions=excluded.impressions,likes=excluded.likes,comments=excluded.comments,source='api'
    WHERE snapshots.source<>'api'`);
}

function accountCredentials(value) {
  const accounts = JSON.parse(value);
  if (!Array.isArray(accounts) || !accounts.length || accounts.some(item => !item || typeof item.accessToken !== 'string' || !item.accessToken)) {
    throw new Error('账号凭据格式无效');
  }
  return accounts;
}

async function collectInstagram(rows, env) {
  const accounts = accountCredentials(env.INSTAGRAM_ACCOUNTS);
  const pending = new Set(rows.map(row => row.id));
  const metricsById = new Map();
  let missingViews = 0;
  const base = 'https://graph.instagram.com/v27.0';
  for (const account of accounts) {
    if (!/^\d+$/.test(account.userId)) throw new Error('Instagram 账号 ID 无效');
    const auth = { headers: { Authorization: 'Bearer ' + account.accessToken } };
    let after;
    do {
      const query = new URLSearchParams({fields: 'id,permalink,like_count,comments_count', limit: '100'});
      if (after) query.set('after', after);
      const page = await readJson(base + '/' + account.userId + '/media?' + query, auth, 'Instagram');
      for (const media of page.data || []) {
        if (typeof media.permalink !== 'string' || !URL.canParse(media.permalink) || !/^\d+$/.test(media.id)) continue;
        const id = 'instagram:' + instagramCode(new URL(media.permalink).pathname);
        if (!pending.delete(id)) continue;
        const insights = await readJson(base + '/' + media.id + '/insights?metric=views', auth, 'Instagram')
          .catch(error => { if (error.retryAt) throw error; return null; });
        const views = insights?.data?.find(item => item.name === 'views');
        const value = count(views?.values?.[0]?.value ?? views?.total_value?.value);
        if (value == null) missingViews++;
        metricsById.set(id, [value, count(media.like_count), count(media.comments_count)]);
      }
      const cursor = page.paging?.next && page.paging?.cursors?.after;
      if (!cursor || cursor === after) break;
      after = cursor;
    } while (pending.size);
    if (!pending.size) break;
  }
  return { metricsById, issue: pending.size ? '部分 Instagram 帖子不属于已授权账号或暂不可读'
    : missingViews ? '部分 Instagram 帖子的浏览量暂不可读，请检查分析权限' : null };
}

async function collectTikTok(rows, env) {
  const accounts = accountCredentials(env.TIKTOK_ACCOUNTS);
  const pending = new Set(rows.filter(row => row.id.startsWith('tiktok:')).map(row => row.id.slice(7)));
  const unresolved = rows.length - pending.size;
  const metricsById = new Map();
  const issues = [];
  for (const account of accounts) {
    const ids = [...pending];
    for (let i = 0; i < ids.length; i += 20) {
      const batch = ids.slice(i, i + 20);
      const data = await readJson('https://open.tiktokapis.com/v2/video/query/?fields=id,view_count,like_count,comment_count', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + account.accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ filters: { video_ids: batch } }),
      }, 'TikTok');
      if (data.error?.code !== 'ok') throw new Error('TikTok API 请求失败');
      for (const video of data.data?.videos || []) {
        if (!pending.delete(video.id)) continue;
        metricsById.set('tiktok:' + video.id, [count(video.view_count), count(video.like_count), count(video.comment_count)]);
      }
    }
    if (!pending.size) break;
  }
  if (unresolved) issues.push('部分 TikTok 链接缺少视频 ID');
  if (pending.size) issues.push('部分 TikTok 视频不属于已授权账号或暂不可读');
  return { metricsById, issue: issues.join(' · ') || null };
}

async function collectOtherPlatforms(env, state, previous) {
  for (const [platform, key, collectPlatform] of [
    ['Instagram', 'INSTAGRAM_ACCOUNTS', collectInstagram],
    ['TikTok', 'TIKTOK_ACCOUNTS', collectTikTok],
  ]) {
    if (env[platform === 'Instagram' ? 'INSTAGRAM_COLLECTION_MODE' : 'TIKTOK_COLLECTION_MODE'] !== 'api') continue;
    const { results: rows } = await env.DB.prepare(`SELECT p.id FROM posts p WHERE p.active=1 AND p.platform=?
      AND NOT EXISTS (SELECT 1 FROM snapshots s WHERE s.post_id=p.id AND s.hour=? AND s.source='api')`)
      .bind(platform, state.hour).all();
    if (!rows.length) continue;
    let issue;
    const resume = previous.platformRetries?.[platform];
    if (!env[key]) {
      issue = '待配置 ' + platform + ' 账号授权';
    } else if (resume > Date.now()) {
      state.platformRetries[platform] = resume;
      issue = platform + ' API 限流，等待重试';
    } else {
      try {
        const result = await collectPlatform(rows, env);
        const writes = [...result.metricsById].map(([id, values]) => snapshot(env.DB).bind(id, state.hour, Date.now(), ...values));
        for (let i = 0; i < writes.length; i += 100) await env.DB.batch(writes.slice(i, i + 100));
        issue = result.issue;
      } catch (error) {
        issue = platform + ' API 请求失败，请检查授权状态';
        if (error.retryAt) state.platformRetries[platform] = error.retryAt;
      }
    }
    if (issue) state.collectionIssue = [state.collectionIssue, issue].filter(Boolean).join(' · ');
  }
}
async function collect(env) {
  const now = Date.now();
  const hour = hourOf(now);
  const db = env.DB;
  const previous = await getSetting(db, 'run') || {};
  const state = { hour, attemptedAt: now, collectionIssue: null, retryAt: null, platformRetries: {} };
  if (previous.hour === hour && previous.collectionIssue === null && previous.collected > 0) return previous;
  if (env.X_COLLECTION_MODE === 'api') await collectX(env, state, previous);
  await collectOtherPlatforms(env, state, previous);
  state.collected = await db.prepare("SELECT count(*) AS n FROM snapshots WHERE hour=? AND source='api'").bind(hour).first('n');
  await putSetting(db, 'run', state);
  return state;
}

async function collectX(env, state, previous) {
  const { DB: db } = env;
  const { hour, attemptedAt: now } = state;
  const { results: posts } = await db.prepare(`SELECT p.id FROM posts p
    WHERE p.active=1 AND p.platform='X' AND NOT EXISTS
    (SELECT 1 FROM snapshots s WHERE s.post_id=p.id AND s.hour=? AND s.source='api') ORDER BY p.id`).bind(hour).all();
  if (posts.length && !env.X_BEARER_TOKEN) {
    state.collectionIssue = '待配置 X API 凭据';
  } else if (previous.retryAt > now) {
    state.collectionIssue = 'X API 限流，等待重试';
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
          return snapshot(db)
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
}

function safeIssue(error, fallback) {
  return /^(?:X请求失败|待配置)/.test(error.message)
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

async function dashboard(env, query) {
  const db = env.DB;
  const unit = ['hour', 'day', 'month', 'year'].includes(query.get('unit')) ? query.get('unit') : 'day';
  const now = hourOf(Date.now());
  const starts = { hour: now - 24 * hourMs, day: now - 29 * 24 * hourMs, month: now - 335 * 24 * hourMs, year: now - 4 * 365 * 24 * hourMs };
  const from = parseDay(query.get('from'));
  const to = parseDay(query.get('to'));
  const start = Number.isFinite(from) ? from : floorPeriod(starts[unit], unit);
  const end = Math.min(Number.isFinite(to) ? to + 24 * hourMs : Date.now(), Date.now());
  const windows = [];
  for (let left = start; left < end;) {
    if (windows.length >= 744) return json({ error: '时间范围过长，请缩短范围或切换时间粒度' }, 400);
    const right = Math.min(end, nextPeriod(floorPeriod(left, unit), unit));
    windows.push({ start: left, end: right });
    left = right;
  }
  const platform = query.get('platform') || '';
  const account = query.get('account') || '';
  const filter = "p.active=1 AND (p.id LIKE 'x:%' OR p.id LIKE 'instagram:%' OR p.id LIKE 'tiktok:%')" +
    " AND (?='' OR p.platform=?) AND (?='' OR p.account=?)";
  const args = [platform, platform, account, account];
  const [{ results: posts }, { results: options }, run, accountFeedAt, { results: storedProfiles }] = await Promise.all([
    db.prepare(`SELECT p.*,s.impressions,s.likes,s.comments,s.saves,s.captured_at,s.source FROM posts p LEFT JOIN snapshots s
      ON s.post_id=p.id AND s.hour=(SELECT t.hour FROM snapshots t WHERE t.post_id=p.id AND t.hour<=? ORDER BY t.hour DESC LIMIT 1)
      WHERE ${filter} ORDER BY s.impressions DESC, p.id`).bind(end, ...args).all(),
    db.prepare(`SELECT DISTINCT platform,account FROM posts p WHERE ${filter} ORDER BY platform,account`).bind('', '', '', '').all(),
    getSetting(db, 'run'),
    getSetting(db, 'accountFeedAt'),
    db.prepare("SELECT value FROM settings WHERE key LIKE 'profile:%' ORDER BY key").all(),
  ]);
  const modes = {
    X: env.X_COLLECTION_MODE === 'api' ? 'api' : 'web',
    Instagram: env.INSTAGRAM_COLLECTION_MODE === 'api' ? 'api' : 'web',
    TikTok: env.TIKTOK_COLLECTION_MODE === 'api' ? 'api' : 'web',
  };
  const status = run && { ...run, syncIssue: null, retryAt: modes.X === 'api' ? run.retryAt : null,
    collectionIssue: (run.collectionIssue || '').split(' · ').filter(issue =>
      !Object.entries(modes).some(([platform, mode]) => mode === 'web' && issue.includes(platform))
    ).join(' · ') || null };
  const allProfiles = storedProfiles.map(row => JSON.parse(row.value));
  const profiles = allProfiles
    .filter(profile => (!platform || profile.platform === platform) &&
      (!account || profile.handle.toLowerCase() === account.replace(/^@/, '').toLowerCase() ||
        options.some(item => item.platform === profile.platform && item.account === account) &&
          allProfiles.filter(item => item.platform === profile.platform).length === 1));
  const selected = new Set(query.getAll('post'));
  const publishedFrom = parseDay(query.get('publishedFrom'));
  const publishedTo = parseDay(query.get('publishedTo'));
  const hasDateFilter = platform && (query.has('publishedFrom') || query.has('publishedTo'));
  if (hasDateFilter && (!Number.isFinite(publishedFrom) || !Number.isFinite(publishedTo) || publishedFrom > publishedTo)) {
    return json({ error: '请选择有效的开始和结束发布日期' }, 400);
  }
  const hasPostFilter = selected.size > 0 || hasDateFilter;
  const matchingPosts = posts.filter(post =>
    (!selected.size || selected.has(post.id)) &&
    (!hasDateFilter || post.published_at != null &&
      post.published_at >= publishedFrom && post.published_at < publishedTo + 24 * hourMs));
  const trendFilter = hasPostFilter ? filter + ' AND p.id IN (SELECT value FROM json_each(?))' : filter;
  const trendArgs = hasPostFilter ? [...args, JSON.stringify(matchingPosts.map(post=>post.id))] : args;
  const trend = platform
    ? await postTrend(db, windows, trendFilter, trendArgs)
    : await followerTrend(db, profiles, windows, start, end);
  return json({ posts, options, run: status, trend, trendPostCount: matchingPosts.length, unit, start, end, modes, profiles, accountFeedAt });
}

async function postTrend(db, windows, filter, args) {
  const trend = [];
  for (let i = 0; i < windows.length; i += 30) {
    const batch = windows.slice(i, i + 30);
    const rows = batch.map(() => '(?,?)').join(',');
    const select = [...metrics, 'saves'].map(metric => `sum(b.${metric}-a.${metric}) AS ${metric},
      count(b.${metric}-a.${metric}) AS ${metric}_coverage`).join(',');
    const { results } = await db.prepare(`WITH windows(start,end) AS (VALUES ${rows})
      SELECT w.start,w.end,count(p.id) AS expected,${select} FROM windows w
      LEFT JOIN posts p ON p.first_hour<w.end AND ${filter}
      LEFT JOIN snapshots b ON b.post_id=p.id AND b.hour=(
        SELECT s.hour FROM snapshots s WHERE s.post_id=p.id AND s.hour>=w.start AND s.hour<w.end
        AND s.captured_at<w.end ORDER BY s.hour DESC LIMIT 1
      )
      LEFT JOIN snapshots a ON a.post_id=p.id AND a.hour=coalesce(
        (SELECT s.hour FROM snapshots s WHERE s.post_id=p.id AND s.source=b.source
          AND s.hour<w.start AND s.captured_at<w.start ORDER BY s.hour DESC LIMIT 1),
        (SELECT s.hour FROM snapshots s WHERE s.post_id=p.id AND s.source=b.source
          AND s.hour>=w.start AND s.hour<b.hour ORDER BY s.hour LIMIT 1)
      )
      GROUP BY w.start,w.end ORDER BY w.start`)
      .bind(...batch.flatMap(period => [period.start, period.end]), ...args).all();
    trend.push(...results);
  }
  return trend;
}

async function followerTrend(db, profiles, windows, start, end) {
  const history = await Promise.all(profiles.map(async ({ platform, handle }) => {
    const { results } = await db.prepare(`WITH history AS (
      SELECT captured_at,followers,lag(followers) OVER (ORDER BY captured_at) AS previous
      FROM profile_snapshots WHERE platform=? AND handle=? AND captured_at<?
    ) SELECT captured_at,followers,previous FROM history WHERE captured_at>=? ORDER BY captured_at`)
      .bind(platform, handle.toLowerCase(), end, start).all();
    return results;
  }));
  const cursors = profiles.map(() => 0);
  return windows.map(window => ({ ...window, accounts: profiles.map(({ platform, handle }, index) => {
    const events = history[index];
    const first = events[cursors[index]];
    if (!first || first.captured_at >= window.end) return { platform, handle, followers: null, growth: null, percent: null };
    let last = first;
    while (events[cursors[index]]?.captured_at < window.end) last = events[cursors[index]++];
    const baseline = first.previous ?? (first !== last ? first.followers : null);
    const growth = baseline == null ? null : last.followers - baseline;
    return { platform, handle, followers: last.followers, sampledAt: last.captured_at, growth, percent: baseline > 0 ? growth / baseline * 100 : null };
  }) }));
}
function profileCount(value) {
  if (count(value) != null) return value;
  return typeof value === 'string' && /^\d+(?:[.,]\d+)?\s*(?:[KMB]|万|亿)$/i.test(value) ? value : null;
}

async function saveWebProfile(request, env) {
  if (!env.COLLECT_TOKEN || request.headers.get('Authorization') !== 'Bearer ' + env.COLLECT_TOKEN) {
    return json({ error: '未授权' }, 403);
  }
  const rows = await request.json();
  if (!Array.isArray(rows) || !rows.length || rows.length > 25) return json({ error: '账号数据格式无效' }, 400);
  const sites = { X: 'https://x.com/', Instagram: 'https://www.instagram.com/', TikTok: 'https://www.tiktok.com/@' };
  const capturedAt = Date.now();
  const profiles = [];
  for (const item of rows) {
    const { platform, handle } = item || {};
    const followers = profileCount(item?.followers);
    const following = profileCount(item?.following);
    if (!Object.hasOwn(sites, platform) || typeof handle !== 'string' || !/^[\w.]{1,40}$/.test(handle) ||
        (followers == null && following == null)) return json({ error: '账号数据格式无效' }, 400);
    profiles.push({ platform, handle, followers, following, capturedAt, url: sites[platform] + handle });
  }
  const writes = [];
  for (const profile of profiles) {
    const handle = profile.handle.toLowerCase();
    const key = 'profile:' + profile.platform + ':' + handle;
    const previous = await getSetting(env.DB, key);
    if (previous && count(previous.followers) != null && Number.isSafeInteger(previous.capturedAt)) {
      writes.push(env.DB.prepare('INSERT OR IGNORE INTO profile_snapshots VALUES (?,?,?,?)')
        .bind(profile.platform, handle, previous.capturedAt, previous.followers));
    }
    if (count(profile.followers) != null) {
      writes.push(env.DB.prepare('INSERT OR IGNORE INTO profile_snapshots VALUES (?,?,?,?)')
        .bind(profile.platform, handle, capturedAt, profile.followers));
    }
    writes.push(env.DB.prepare(`INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .bind(key, JSON.stringify(profile)));
  }
  await env.DB.batch(writes);
  return json({ saved: profiles.length });
}
function capturedTitle(entry) {
  return typeof entry?.title === 'string' ? entry.title.trim().slice(0, 160) : '';
}

function hasWebMetrics(entry) {
  return metrics.some(metric => count(entry[metric]) != null) ||
    (entry.id.startsWith('tiktok:') && count(entry.saves) != null);
}

async function saveWebSnapshot(request, env) {
  if (!env.COLLECT_TOKEN || request.headers.get('Authorization') !== 'Bearer ' + env.COLLECT_TOKEN) {
    return json({ error: '未授权' }, 403);
  }
  const entries = await request.json();
  if (!Array.isArray(entries) || !entries.length || entries.length > 50 ||
      entries.some(entry => typeof entry?.id !== 'string' || !entry.id ||
        (!hasWebMetrics(entry) && !capturedTitle(entry) && !Number.isSafeInteger(entry.publishedAt)))) return json({ error: '网页指标格式无效' }, 400);
  const now = Date.now();
  const discovered = [];
  const metadata = [];
  const writes = [];
  for (const entry of entries) {
    if (entry.url != null || entry.platform != null) {
      const post = accountPost(entry);
      if (!post) return json({ error: '帖子链接与采集账号不匹配' }, 400);
      discovered.push(env.DB.prepare(`INSERT INTO posts
        (id,platform,account,url,title,active,first_hour,parent_id) VALUES (?,?,?,?,?,1,?,NULL)
        ON CONFLICT(id) DO UPDATE SET active=1, url=excluded.url, account=excluded.account, parent_id=NULL,
        title=coalesce(nullif(posts.title,''),excluded.title)`).bind(
          post.id, post.platform, post.account, post.url, post.title, hourOf(now)));
    }
    const title = capturedTitle(entry);
    const publishedAt = Number.isSafeInteger(entry.publishedAt) && entry.publishedAt > 0 && entry.publishedAt <= now
      ? entry.publishedAt : null;
    if (publishedAt != null || (title && entry.url == null)) {
      metadata.push(env.DB.prepare(`UPDATE posts SET title=coalesce(nullif(title,''),?),
        published_at=coalesce(?,published_at) WHERE id=? AND active=1`).bind(title, publishedAt, entry.id));
    }
    if (!hasWebMetrics(entry)) continue;
    writes.push(env.DB.prepare(`INSERT INTO snapshots
      (post_id,hour,captured_at,impressions,likes,comments,source,saves)
      SELECT id,?,?,?,?,?,'web',? FROM posts WHERE id=? AND active=1
      ON CONFLICT(post_id,hour) DO UPDATE SET captured_at=excluded.captured_at,impressions=excluded.impressions,
        likes=excluded.likes,comments=excluded.comments,saves=coalesce(excluded.saves,snapshots.saves) WHERE snapshots.source='web'`)
      .bind(hourOf(now), now, ...metrics.map(metric => count(entry[metric])), entry.id.startsWith('tiktok:') ? count(entry.saves) : null, entry.id));
  }
  const results = (await env.DB.batch([...discovered, ...metadata, ...writes])).slice(discovered.length);
  const named = results.slice(0, metadata.length).reduce((sum, result) => sum + result.meta.changes, 0);
  const saved = results.slice(metadata.length).reduce((sum, result) => sum + result.meta.changes, 0);
  if (discovered.length && saved) await putSetting(env.DB, 'accountFeedAt', now);
  return json({ named, saved });
}
async function mcp(request, env) {
  const rpc = await request.json();
  const reply = (result) => json({ jsonrpc: '2.0', id: rpc.id, result });
  if (rpc.method === 'server/discover') {
    return reply({ supportedVersions: ['2026-07-28'], capabilities: { tools: {} } });
  }
  if (rpc.method === 'tools/list') {
    return reply({ tools: [{ name: 'collect_metrics', description: '采集已配置接口账号的本小时指标', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] });
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
        const selected = url.searchParams.get('platform');
        return new Response(Object.hasOwn(accountFeeds, selected) ? platformHtml : html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' } });
      }
      if (request.method === 'GET' && url.pathname === '/api/dashboard') return await dashboard(env, url.searchParams);
      if (request.method === 'POST' && url.pathname === '/mcp') return await mcp(request, env);
      if (request.method === 'POST' && url.pathname === '/api/web-profiles') return await saveWebProfile(request, env);
      if (request.method === 'POST' && url.pathname === '/api/web-snapshots') return await saveWebSnapshot(request, env);
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
