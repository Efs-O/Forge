import { chromium } from 'playwright-core';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
});
try {
  for (const mode of ['full', 'compact', 'current', 'proposed', 'complete', 'details', 'queued', 'clanker']) {
    const page = await browser.newPage({ viewport: { width: mode === 'queued' || mode === 'clanker' ? 440 : 1100, height: 760 }, deviceScaleFactor: 1 });
    await page.goto(`${pathToFileURL(join(dir, 'preview.html'))}?mode=${mode}`);
    await page.screenshot({ path: join(dir, `${mode}.png`), animations: 'disabled' });
    await page.close();
  }
} finally {
  await browser.close();
}
