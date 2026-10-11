import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [join(dir, 'actual-entry.tsx')],
  outfile: join(dir, 'actual-entry.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  loader: { '.css': 'css' },
});
const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
});
try {
  for (const [mode, theme, width] of [
    ['complete', 'dark', 440], ['details', 'dark', 440], ['call', 'dark', 440],
    ['queued', 'dark', 440], ['clanker', 'dark', 440],
    ['complete', 'light', 440], ['complete', 'dark', 1100],
  ]) {
    const page = await browser.newPage({ viewport: { width, height: 760 } });
    await page.goto(`${pathToFileURL(join(dir, 'actual-preview.html'))}?mode=${mode}&theme=${theme}`);
    await page.locator('.activity-group').first().waitFor();
    if (mode === 'details' || mode === 'call') await page.locator('.activity-group-toggle').first().click();
    if (mode === 'call') await page.locator('.activity-row-header').first().click();
    await page.screenshot({ path: join(dir, `actual-${mode}-${theme}-${width}.png`) });
    await page.close();
  }
} finally {
  await browser.close();
}
