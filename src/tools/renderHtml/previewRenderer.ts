import { guardedFetchResource } from './previewFetch';
import type { BrowserChannel } from '../browser/BrowserSessionManager';
import { PREVIEW_LAUNCH_ARGS, PREVIEW_ORIGIN, withRenderBrowser } from './renderBrowser';

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
  /** First distinct page exceptions and console errors, with repeats counted. */
  errors: string[];
  /** All errors seen, including the ones not listed. */
  errorCount: number;
  /** Error events beyond the displayed distinct-message cap. */
  suppressedErrorCount: number;
  /** `scheme://host (reason)` of every request that did not load, one per origin. */
  blocked: string[];
  consoleLines: string[];
  consoleDropped: number;
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
      const errors = new Map<string, { message: string; count: number }>();
      let errorCount = 0;
      let suppressedErrorCount = 0;
      const consoleLines: string[] = [];
      let consoleDropped = 0;
      const record = (text: string): void => {
        errorCount += 1;
        const message =
          text.length > MAX_PREVIEW_ERROR_CHARS
            ? `${text.slice(0, MAX_PREVIEW_ERROR_CHARS)}…`
            : text;
        const existing = errors.get(message);
        if (existing) {
          existing.count += 1;
        } else if (errors.size < MAX_PREVIEW_ERRORS) {
          errors.set(message, { message, count: 1 });
        } else {
          suppressedErrorCount += 1;
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
          errors: [...errors.values()].map(({ message, count }) =>
            count > 1 ? `${message} (x${count})` : message,
          ),
          errorCount,
          suppressedErrorCount,
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
