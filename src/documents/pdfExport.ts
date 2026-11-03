import { DEFAULT_BROWSER_CHANNEL } from '../config/browserSchema';
import type { ForgeConfig } from '../config/types';
import { HARDENED_LAUNCH_ARGS, withRenderBrowser } from '../tools/renderHtml/renderBrowser';

export async function printHtmlToPdf(
  html: string,
  getConfig: (() => ForgeConfig) | undefined,
  abortSignal: AbortSignal | undefined,
): Promise<Buffer> {
  if (Buffer.byteLength(html, 'utf8') > 2 * 1024 * 1024)
    throw new Error('export_document: rendered HTML exceeds the 2 MiB limit.');
  return withRenderBrowser(
    {
      channel: getConfig?.().browser?.channel ?? DEFAULT_BROWSER_CHANNEL,
      timeoutMs: 30_000,
      args: HARDENED_LAUNCH_ARGS,
    },
    abortSignal,
    async (browser) => {
      const context = await browser.newContext({ javaScriptEnabled: false });
      await context.route('**/*', (route) => void route.abort());
      try {
        const page = await context.newPage();
        await page.setContent(html, { waitUntil: 'load', timeout: 15_000 });
        if (abortSignal?.aborted) throw new Error('export_document: cancelled before printing.');
        const pdf = await page.pdf({
          format: 'A4',
          printBackground: true,
          preferCSSPageSize: true,
        });
        if (abortSignal?.aborted) throw new Error('export_document: cancelled during printing.');
        return Buffer.from(pdf);
      } finally {
        await context.close().catch(() => undefined);
      }
    },
  );
}
