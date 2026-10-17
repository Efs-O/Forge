import type { BrowserChannel } from '../browser/BrowserSessionManager';
import { HARDENED_LAUNCH_ARGS, withRenderBrowser } from './renderBrowser';

export interface RenderRequest {
  html: string;
  width: number;
  height: number;
  fullPage: boolean;
  channel: BrowserChannel;
  timeoutMs: number;
  /**
   * When set, a `full_page` capture taller than this is refused BEFORE Chrome
   * rasterises it. Only meaningful with fullPage: a viewport-clipped shot can
   * never exceed the viewport.
   */
  maxHeightPx?: number;
}

/**
 * Document height in CSS px, read from the live layout. `scrollHeight` on the
 * document element is what a `full_page` capture uses; `body` is the fallback
 * for a fragment whose documentElement reports 0.
 */
async function measureContentHeight(page: {
  evaluate: (fn: () => number) => Promise<number>;
}): Promise<number> {
  return page.evaluate(() => {
    // This file is compiled against the Node lib, which has no `document`.
    // Playwright serializes this callback and runs it in the page, where
    // globalThis IS the window — so reach the document through globalThis with
    // a local shape instead of pulling the DOM lib into the extension build.
    const doc = (
      globalThis as unknown as {
        document?: {
          documentElement?: { scrollHeight?: number; offsetHeight?: number };
          body?: { scrollHeight?: number };
        };
      }
    ).document;
    return Math.max(
      doc?.documentElement?.scrollHeight ?? 0,
      doc?.body?.scrollHeight ?? 0,
      doc?.documentElement?.offsetHeight ?? 0,
    );
  });
}

/** Image mode: JS off, every request blocked, one PNG. */
export async function renderPng(
  request: RenderRequest,
  abortSignal: AbortSignal | undefined,
): Promise<Buffer> {
  return withRenderBrowser(
    { channel: request.channel, timeoutMs: request.timeoutMs, args: HARDENED_LAUNCH_ARGS },
    abortSignal,
    async (handle) => {
      const context = await handle.newContext({
        viewport: { width: request.width, height: request.height },
        deviceScaleFactor: 1,
        // Set on the context: Playwright has no page-level setter. The HTML is
        // inert — no timers, no DOM manipulation, no data access — so the same
        // input produces the same pixels.
        javaScriptEnabled: false,
      });
      // Registered on the CONTEXT, before setContent, so nothing the page asks
      // for can reach the network. data: URLs never reach a route handler in
      // Chromium (they resolve internally), so no data: branch is needed here.
      await context.route('**/*', (route) => void route.abort());
      try {
        const page = await context.newPage();
        // setContent, never file:// navigation: that would need the origin-
        // approval machinery the browser tools use, and a file:// origin can
        // read the local disk.
        await page.setContent(request.html, { waitUntil: 'load' });
        // Measure BEFORE rasterising. `full_page` with a runaway layout is the
        // memory risk, and measuring first refuses it without Chrome ever
        // allocating the buffer. (Measured 2026-10-03: `page.evaluate` DOES see
        // the layout under javaScriptEnabled:false — JS is disabled for the
        // PAGE's scripts, not for Playwright's own evaluation channel.)
        if (request.maxHeightPx !== undefined) {
          const contentHeight = await measureContentHeight(page);
          if (contentHeight > request.maxHeightPx) {
            throw new Error(
              `render_html_to_image: the page is ${contentHeight.toLocaleString()} px tall; ` +
                `full_page is capped at ${request.maxHeightPx.toLocaleString()} px. ` +
                'Shorten the layout or render it viewport-clipped.',
            );
          }
        }
        return await page.screenshot({ type: 'png', fullPage: request.fullPage });
      } finally {
        await context.close().catch(() => undefined);
      }
    },
  );
}
