const { readFile } = await import("node:fs/promises");
const config = JSON.parse(await readFile("C:/Users/drovio/social-post-insights-browser.json", "utf8"));
const call = async (path, data) => {
  const response = await fetch(config.url + path, {
    method: "POST", redirect: "error",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + config.collectToken,
      "OAI-Sites-Authorization": "Bearer " + config.siteToken,
    },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error("看板采集接口返回 " + response.status);
  return response.json();
};

const queue = await call("/api/browser/queue", {});
if (!queue.posts.length) {
  console.log("本时段没有待采集的 X 帖子");
} else {
  const task = await taskSpace("X 网页指标采集");
  const page = task.page("p1");
  let results = [];
  let submitted = 0;
  try {
    for (const post of queue.posts) {
      const url = new URL(post.url);
      const id = post.id.match(/^x:(\d+)$/)?.[1];
      if (url.origin !== "https://x.com" || !id || !url.pathname.endsWith("/status/" + id)) continue;
      let values;
      try {
        await page.goto(url.href, { timeout: 20000 });
        await page.waitForSelector('article [role="group"][aria-label]', { timeout: 10000 });
        values = await page.evaluate((id) => {
          const article = [...document.querySelectorAll("article")].find(node =>
            [...node.querySelectorAll("a[href]")].some(link =>
              new URL(link.href).pathname.split("/").some((part, i, parts) => part === id && parts[i - 1] === "status"))
          );
          const group = article?.querySelector('[role="group"][aria-label]');
          if (!group) return {};
          const label = group.getAttribute("aria-label");
          function parse(pattern) {
            const raw = label.match(pattern)?.[1]?.replaceAll(",", "").replaceAll(" ", "");
            return raw && /^\d+$/.test(raw) ? Number(raw) : null;
          }
          function metric(pattern, control) {
            const found = parse(pattern);
            if (found !== null) return found;
            const node = group.querySelector(control);
            const aria = node?.getAttribute("aria-label") || "";
            return /(?:^|\D)0(?:\D|$)/.test(aria) ? 0 : null;
          }
          return {
            impressions: metric(/([\d,]+)\s+(?:views?|impressions?)\b/i, 'a[href$="/analytics"]'),
            likes: metric(/([\d,]+)\s+likes?\b/i, '[data-testid="like"],[data-testid="unlike"]'),
            comments: metric(/([\d,]+)\s+repl(?:y|ies)\b/i, '[data-testid="reply"]'),
          };
        }, id);
      } catch {
        values = {};
      }
      results.push({ id: post.id, ...values });
      if (results.length === 25) {
        const state = await call("/api/browser/metrics", { hour: queue.hour, results });
        submitted += results.length;
        results = [];
        console.log(state);
      }
    }
    if (results.length) {
      console.log(await call("/api/browser/metrics", { hour: queue.hour, results }));
      submitted += results.length;
    }
    console.log("已提交 " + submitted + " 条网页采集结果");
  } finally {
    await task.finish({ keep: [] });
  }
}