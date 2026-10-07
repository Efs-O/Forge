import { getPlaywright, type BrowserChannel } from '../browser/BrowserSessionManager';

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

/**
 * Preview mode's only reachable hosts: the script CDNs a single-file page pulls
 * three.js and friends from. A constant, not config — it is a security
 * boundary, and a config field would make "allow everything" one edit away
 * (RENDER_PREVIEW_PLAN.md).
 */
export const PREVIEW_ALLOWED_HOSTS = [
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'unpkg.com',
] as const;

/**
 * The image-mode args with the DNS wall opened for the allowlist only, plus a
 * WebRTC policy. With scripts on, `context.route` is the first wall and DNS the
 * second; WebRTC's STUN traffic is UDP that neither sees. Measured 2026-10-07:
 * `stun:127.0.0.1:<port>` delivered 5 UDP packets to a loopback socket without
 * the policy and 0 with it; WebSocket, EventSource and sendBeacon to 127.0.0.1
 * and localhost opened 0 TCP connections either way.
 */
export const PREVIEW_LAUNCH_ARGS = [
  ...HARDENED_LAUNCH_ARGS.filter((arg) => !arg.startsWith('--host-resolver-rules=')),
  `--host-resolver-rules=MAP * ~NOTFOUND, ${PREVIEW_ALLOWED_HOSTS.map((h) => `EXCLUDE ${h}`).join(', ')}`,
  '--webrtc-ip-handling-policy=disable_non_proxied_udp',
] as const;

/** Preview requests that may leave the browser: GET over https to the allowlist. */
export function isPreviewRequestAllowed(url: string, method: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    method === 'GET' &&
    parsed.protocol === 'https:' &&
    (PREVIEW_ALLOWED_HOSTS as readonly string[]).includes(parsed.hostname)
  );
}

/** Errors kept per preview; the rest are counted, not listed. */
const MAX_PREVIEW_ERRORS = 10;
/** One error line's cap — a minified stack is otherwise one huge line. */
const MAX_PREVIEW_ERROR_CHARS = 300;

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
  /** Wait after `load` before the screenshot, for scripts that build the scene. */
  settleMs: number;
}

export interface PreviewResult {
  png: Buffer;
  /** Page exceptions and console errors, first {@link MAX_PREVIEW_ERRORS}. */
  errors: string[];
  /** All errors seen, including the ones not listed. */
  errorCount: number;
  /** `scheme://host` of every request the route refused, de-duplicated. */
  blocked: string[];
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
async function withRenderBrowser<T>(
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
 * Preview mode: the page's own scripts run, so a canvas/WebGL scene the agent
 * wrote actually draws. Still `setContent` (no `file://` origin, no disk
 * reads); requests leave only as GETs to {@link PREVIEW_ALLOWED_HOSTS}, with
 * DNS for every other host mapped to NOTFOUND behind the route. Errors the page
 * raises are returned with the PNG — a boot crash is the most common reason a
 * scene is blank.
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
      const blocked = new Set<string>();
      await context.route('**/*', (route) => {
        const req = route.request();
        if (isPreviewRequestAllowed(req.url(), req.method())) return void route.continue();
        blocked.add(originLabel(req.url()));
        return void route.abort();
      });
      const errors: string[] = [];
      let errorCount = 0;
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
          if (msg.type() === 'error') record(msg.text());
        });
        await page.setContent(request.html, { waitUntil: 'load' });
        if (request.settleMs > 0) await page.waitForTimeout(request.settleMs);
        const png = await page.screenshot({ type: 'png' });
        return { png, errors, errorCount, blocked: [...blocked] };
      } finally {
        await context.close().catch(() => undefined);
      }
    },
  );
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
