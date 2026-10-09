import { getPlaywright, type BrowserChannel } from '../browser/BrowserSessionManager';
import { guardedFetchResource } from './previewFetch';

/**
 * The render half of `render_html_to_image`: launch a headless browser,
 * render the HTML, take one PNG, and guarantee the browser is closed on every
 * exit. Kept separate from the tool (schema, input validation, output naming,
 * delivery) because the two change for different reasons — and because the
 * tool file has a lot of policy around the render.
 */

/**
 * Chrome's own outbound traffic, not the page's. `context.route` blocks page
 * requests only; the component updater, variations fetches and DNS prefetch for
 * `<link rel="dns-prefetch">` bypass it. `--host-resolver-rules=MAP * ~NOTFOUND`
 * is the backstop: nothing resolves at all.
 *
 * Two deliberate omissions. No `EXCLUDE localhost`: Playwright drives Chrome
 * over `--remote-debugging-pipe`, not a localhost socket, so an exclusion would
 * only open a hole to Forge's own control server on 127.0.0.1:8799. And no
 * quotes inside the rule — `args` is an array passed without a shell, so
 * literal quotes would become part of the value.
 */
const HARDENED_LAUNCH_ARGS = [
  '--disable-background-networking',
  '--disable-component-update',
  '--no-pings',
  '--host-resolver-rules=MAP * ~NOTFOUND',
] as const;

/** Chrome resolves nothing itself; the extension host fetches every routed URL after DNS pinning. */
export const PREVIEW_LAUNCH_ARGS = [
  ...HARDENED_LAUNCH_ARGS.filter((arg) => !arg.startsWith('--host-resolver-rules=')),
  '--host-resolver-rules=MAP * ~NOTFOUND',
  '--webrtc-ip-handling-policy=disable_non_proxied_udp',
] as const;

/** Preview URLs must be public HTTP(S); the host-side fetch guard checks DNS results. */
export function isPreviewRequestAllowed(url: string, method: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    ['GET', 'POST'].includes(method) &&
    (parsed.protocol === 'https:' || parsed.protocol === 'http:')
  );
}

/** Errors kept per preview; the rest are counted, not listed. */
const MAX_PREVIEW_ERRORS = 10;
/** One error line's cap — a minified stack is otherwise one huge line. */
const MAX_PREVIEW_ERROR_CHARS = 300;
const MAX_PREVIEW_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_PREVIEW_CONSOLE_LINES = 40;
const MAX_PREVIEW_CONSOLE_CHARS = 4_000;
export const PREVIEW_ORIGIN = 'https://forge-preview.invalid';

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

export interface PreviewRequest {
  html: string;
  width: number;
  height: number;
  channel: BrowserChannel;
  timeoutMs: number;
  frames: number[];
  keys: Array<{ key: string; holdMs: number }>;
}

export interface PreviewResult {
  frames: Array<{ timeMs: number; png: Buffer }>;
  /** Page exceptions and console errors, first {@link MAX_PREVIEW_ERRORS}. */
  errors: string[];
  /** All errors seen, including the ones not listed. */
  errorCount: number;
  /** `scheme://host (reason)` of every request that did not load, one per origin. */
  blocked: string[];
  consoleLines: string[];
  consoleDropped: number;
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

type RenderBrowser = Awaited<ReturnType<ReturnType<typeof getPlaywright>['chromium']['launch']>>;

/**
 * Launch, run `use`, kill — the machinery both modes share — one browser per call, no persistent
 * process and no idle timer.
 *
 * The hard part is not the render, it is never leaving a browser behind. Three
 * exits close it: the `finally` after a normal or failed render, the timeout
 * path (where `chromium.launch` may still RESOLVE afterwards and must close the
 * browser it just got), and an aborted turn. `launched` is written the instant
 * launch resolves and `giveUp` is set the instant the deadline fires, so
 * whichever happens second sees the other and closes the process. A headless
 * Chrome with no GPU is cheap to leak but not free, and nothing else reaps it.
 * An abort is additionally RACED, so cancelling during a stalled launch returns
 * at once instead of waiting for the deadline.
 */
export async function withRenderBrowser<T>(
  launch: { channel: BrowserChannel; timeoutMs: number; args: readonly string[] },
  abortSignal: AbortSignal | undefined,
  use: (handle: RenderBrowser) => Promise<T>,
): Promise<T> {
  const { chromium } = getPlaywright();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let giveUp = false;

  const closeQuietly = async (): Promise<void> => {
    // Take the handle before awaiting, so three exits (finally, timeout,
    // abort) can race and still close exactly once. Never throws: cleanup must
    // not mask the error the caller is about to see.
    const handle = browser;
    browser = undefined;
    if (!handle) return;
    try {
      await handle.close();
    } catch {
      // Already gone (pipe closed) — nothing to do.
    }
  };

  // One handler for both add and remove. An anonymous wrapper here would never
  // be detached: `removeEventListener` compares references, so the listener
  // would outlive the render and keep this closure (browser handle included)
  // reachable on a signal that can live for the whole session
  // (Codex review MUST-FIX, 2026-10-03).
  // The abort is also RACED against, so it is PROMPT: without the rejection, an
  // abort during a stalled `chromium.launch` would wait for launch to return or
  // for the 30 s deadline before the caller saw the cancellation.
  let rejectAborted: ((err: Error) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAborted = reject;
  });
  const onAbort = (): void => {
    giveUp = true;
    void closeQuietly();
    rejectAborted?.(new Error('render_html_to_image: cancelled during rendering.'));
  };
  if (abortSignal) {
    if (abortSignal.aborted) throw new Error('render_html_to_image: cancelled before rendering.');
    abortSignal.addEventListener('abort', onAbort, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const launched = chromium
      .launch({
        channel: launch.channel,
        headless: true,
        args: [...launch.args],
      })
      .then((handle) => {
        browser = handle;
        // launch won the race against the deadline or the abort: close now,
        // because whoever set `giveUp` had no handle to close at the time.
        if (giveUp) void closeQuietly();
        return handle;
      });

    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        giveUp = true;
        void closeQuietly();
        reject(
          new Error(
            `render_html_to_image: timed out after ${launch.timeoutMs / 1000}s; the browser was closed. ` +
              'Simplify the page or raise the viewport budget.',
          ),
        );
      }, launch.timeoutMs);
    });

    const rendered = launched.then(use);

    return await Promise.race([rendered, deadline, aborted]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Only a genuine launch failure gets the "could not be launched" label with
    // the config fix. The bare `launch` alternative used to match ANY message
    // containing that word — a `setContent` or navigation error would be
    // mislabelled and send the user off to change `browser.channel` (review
    // NOTE, 2026-10-03).
    if (
      /browserType\.launch|Executable doesn't exist/i.test(message) &&
      !/timed out/.test(message)
    ) {
      throw new Error(
        `render_html_to_image: ${launch.channel} could not be launched (${message}). ` +
          'Set browser.channel to an installed browser (chrome | msedge). No silent fallback.',
      );
    }
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    abortSignal?.removeEventListener('abort', onAbort);
    await closeQuietly();
  }
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

/**
 * Preview mode: the page's own scripts run on a routed secure synthetic
 * origin, so WebGPU is available. The host fulfills only the page itself;
 * Chrome resolves no host itself (DNS mapped to NOTFOUND), and other public
 * requests go through the extension host's SSRF guard. No file URL or disk
 * access is exposed to the browser.
 */
export async function renderPreview(
  request: PreviewRequest,
  abortSignal: AbortSignal | undefined,
): Promise<PreviewResult> {
  return withRenderBrowser(
    { channel: request.channel, timeoutMs: request.timeoutMs, args: PREVIEW_LAUNCH_ARGS },
    abortSignal,
    async (handle) => {
      const context = await handle.newContext({
        viewport: { width: request.width, height: request.height },
        deviceScaleFactor: 1,
        javaScriptEnabled: true,
      });
      await context.addInitScript(WEBGPU_ERROR_CAPTURE);
      // origin -> why: a public host that timed out must not read as refused.
      const blocked = new Map<string, string>();
      await context.route('**/*', async (route) => {
        const req = route.request();
        const requested = new URL(req.url());
        if (requested.origin === PREVIEW_ORIGIN) {
          if (requested.pathname === '/' && !requested.search && req.method() === 'GET') {
            await route.fulfill({
              status: 200,
              contentType: 'text/html; charset=utf-8',
              body: request.html,
            });
          } else {
            blocked.set(originLabel(req.url()), 'refused: preview serves only the page itself');
            await route.abort();
          }
          return;
        }
        if (!isPreviewRequestAllowed(req.url(), req.method())) {
          blocked.set(
            originLabel(req.url()),
            `refused: ${req.method()} is not an HTTP(S) GET or POST`,
          );
          return void route.abort();
        }
        try {
          const body = req.postDataBuffer();
          const response = await guardedFetchResource(req.url(), {
            method: req.method(),
            ...(body ? { body } : {}),
            headers: safePreviewHeaders(req.headers()),
            maxBytes: MAX_PREVIEW_RESPONSE_BYTES,
          });
          await route.fulfill(response);
        } catch (err) {
          blocked.set(originLabel(req.url()), err instanceof Error ? err.message : String(err));
          await route.abort();
        }
      });
      await context.routeWebSocket('**/*', (socket) => socket.close());
      const errors: string[] = [];
      let errorCount = 0;
      const consoleLines: string[] = [];
      let consoleDropped = 0;
      const record = (text: string): void => {
        errorCount += 1;
        if (errors.length < MAX_PREVIEW_ERRORS) {
          errors.push(
            text.length > MAX_PREVIEW_ERROR_CHARS
              ? `${text.slice(0, MAX_PREVIEW_ERROR_CHARS)}…`
              : text,
          );
        }
      };
      try {
        const page = await context.newPage();
        page.on('pageerror', (err) => record(err.message || String(err)));
        page.on('console', (msg) => {
          const type = msg.type();
          if (type === 'error') record(msg.text());
          if (['log', 'info', 'warn'].includes(type)) {
            // Capped as lines arrive: a page logging every frame for 15 s
            // would otherwise hold every line until the capture ends.
            consoleLines.push(`${type}: ${msg.text()}`.slice(0, MAX_PREVIEW_CONSOLE_CHARS));
            if (consoleLines.length > MAX_PREVIEW_CONSOLE_LINES) {
              consoleLines.shift();
              consoleDropped += 1;
            }
          }
        });
        await page.goto(`${PREVIEW_ORIGIN}/`, { waitUntil: 'load' });
        // Keys go to the focused element, and after setContent nothing has
        // focus: a game listening on its canvas heard none of them (measured
        // 2026-10-08). Focus what a player would click; window listeners
        // still receive the events as they bubble.
        if (request.keys.length > 0) await page.evaluate(FOCUS_GAME_TARGET);
        for (const { key, holdMs } of request.keys)
          await page.keyboard.press(key, { delay: holdMs });
        const frames: PreviewResult['frames'] = [];
        let elapsed = 0;
        for (const timeMs of request.frames) {
          const wait = Math.max(0, timeMs - elapsed);
          if (wait > 0) await page.waitForTimeout(wait);
          frames.push({ timeMs, png: await page.screenshot({ type: 'png' }) });
          elapsed = timeMs;
        }
        const trimmed = capConsoleLines(consoleLines);
        return {
          frames,
          errors,
          errorCount,
          blocked: [...blocked].map(([origin, reason]) => `${origin} (${reason})`),
          consoleLines: trimmed.consoleLines,
          consoleDropped: consoleDropped + trimmed.consoleDropped,
        };
      } finally {
        await context.close().catch(() => undefined);
      }
    },
  );
}

/** Page-side: focus the first canvas or tab-focusable element, unless the page focused one. */
const FOCUS_GAME_TARGET = `(() => {
  if (document.activeElement && document.activeElement !== document.body) return;
  const target = document.querySelector('canvas, [tabindex]:not([tabindex="-1"])');
  if (!target) return;
  if (target instanceof HTMLCanvasElement && !target.hasAttribute('tabindex')) target.tabIndex = -1;
  target.focus();
})()`;

/** Capture shader diagnostics browsers keep out of pageerror and console events. */
const WEBGPU_ERROR_CAPTURE = `(() => {
  if (typeof GPUAdapter === 'undefined' || typeof GPUDevice === 'undefined') return;
  const requestDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function(...args) {
    const device = await requestDevice.apply(this, args);
    device.addEventListener('uncapturederror', event => {
      console.error('webgpu: ' + event.error.message);
    });
    return device;
  };
  const createShaderModule = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function(descriptor) {
    const module = createShaderModule.call(this, descriptor);
    module.getCompilationInfo().then(info => {
      for (const message of info.messages) {
        if (message.type !== 'error') continue;
        console.error('webgpu: ' + message.lineNum + ':' + message.linePos + ': ' + message.message);
      }
    });
    return module;
  };
})()`;

function safePreviewHeaders(headers: Record<string, string>): Record<string, string> {
  const allowed = ['accept', 'content-type', 'origin'];
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => allowed.includes(key.toLowerCase())),
  );
}

function capConsoleLines(lines: string[]): { consoleLines: string[]; consoleDropped: number } {
  const kept = [...lines];
  let chars = kept.reduce((sum, line) => sum + line.length, 0);
  let dropped = 0;
  while (kept.length > MAX_PREVIEW_CONSOLE_LINES || chars > MAX_PREVIEW_CONSOLE_CHARS) {
    const first = kept.shift();
    if (first === undefined) break;
    chars -= first.length;
    dropped += 1;
  }
  return { consoleLines: kept, consoleDropped: dropped };
}

/** `scheme://host` for the blocked list; the raw string when it is not a URL. */
function originLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host ? `${parsed.protocol}//${parsed.host}` : parsed.protocol;
  } catch {
    return url.slice(0, 80);
  }
}
