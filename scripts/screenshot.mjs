// Headless visual verification: builds are served via `vite preview`, each
// canned pose is rendered deterministically (?pose=N&shot) and screenshotted.
// Usage: npm run build && npm run shot [-- --tier 0 --poses 1,2,3,4 --out DIR]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const OUT = arg('out', 'shots');
const TIER = arg('tier', '0');
const POSES = arg('poses', '1,2,3,4').split(',').map(Number);
const PORT = 4173;

mkdirSync(OUT, { recursive: true });

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'],
  { stdio: 'pipe' });
const killServer = () => { try { server.kill('SIGTERM'); } catch { /* gone */ } };
process.on('exit', killServer);

// wait for the server
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/`);
    if (r.ok) break;
  } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 500));
  if (i === 59) { console.error('preview server never came up'); process.exit(1); }
}

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});

let failed = false;
for (const pose of POSES) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  const url = `http://127.0.0.1:${PORT}/?pose=${pose}&shot&tier=${TIER}`;
  console.log(`pose ${pose}: ${url}`);
  const t0 = Date.now();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction('window.__shotReady === true', null, { timeout: 240000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/pose${pose}.png` });
    console.log(`  saved ${OUT}/pose${pose}.png in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.error(`  FAILED: ${e.message}`);
    failed = true;
    try { await page.screenshot({ path: `${OUT}/pose${pose}-FAILED.png` }); } catch { /* */ }
  }
  const pageErrors = await page.evaluate('window.__consoleErrors || []').catch(() => []);
  // 404s for optional star-map assets are the expected fallback path, not bugs.
  const benign = /starmap_8k\.ktx2|starmap_4k\.jpg|basis_transcoder|Failed to load resource.*404/;
  const all = [...new Set([...consoleErrors, ...pageErrors])].filter((e) => !benign.test(e));
  if (all.length) {
    failed = true;
    console.error(`  console errors:\n    ${all.join('\n    ')}`);
    writeFileSync(`${OUT}/pose${pose}-errors.txt`, all.join('\n'));
  }
  await page.close();
}

await browser.close();
killServer();
console.log(failed ? 'DONE WITH FAILURES' : 'DONE — all poses rendered clean');
process.exit(failed ? 1 : 0);
