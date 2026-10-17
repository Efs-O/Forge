import { getPlaywright, type BrowserChannel } from '../browser/BrowserSessionManager';

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
export const HARDENED_LAUNCH_ARGS = [
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

export const PREVIEW_ORIGIN = 'https://forge-preview.invalid';

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
  // The abort is also RACED, so it is PROMPT: without the rejection, an
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
