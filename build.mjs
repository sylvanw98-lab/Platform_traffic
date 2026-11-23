import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
mkdirSync('dist/server', { recursive: true });
mkdirSync('dist/.openai', { recursive: true });
copyFileSync('.openai/hosting.json', 'dist/.openai/hosting.json');
const html = readFileSync('worker/dashboard.html', 'utf8');
const platformHtml = readFileSync('worker/platform-dashboard.html', 'utf8');
const source = readFileSync('worker/index.js', 'utf8');
writeFileSync('dist/server/index.js', source.replace("'__PLATFORM_DASHBOARD__'", () => JSON.stringify(platformHtml)).replace("'__DASHBOARD__'", () => JSON.stringify(html)));
