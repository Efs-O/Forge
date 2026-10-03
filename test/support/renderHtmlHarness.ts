/**
 * A stand-in for Playwright's chromium, shared by the two
 * `render_html_to_image` suites (input/rendering vs cleanup/delivery).
 *
 * The tool reaches the browser ONLY through `getPlaywright()`, so replacing
 * that one function swaps the whole render engine: the suites can assert the
 * launch flags, the context options, the route registration and every cleanup
 * path without a browser binary. Each suite installs it with its own
 * `vi.mock('../../src/tools/browser/BrowserSessionManager', ...)` returning
 * `fakePlaywright()`.
 *
 * State is a module singleton rather than a factory return so both the mock
 * closure and the test body see the same object; `resetRenderFake()` runs in
 * `beforeEach`. The `closed` flag deliberately lives on the per-launch
 * `instance`, not here: a second render in the same test must start with a
 * live browser, exactly as the real thing does.
 */
export interface RenderFake {
  launchCalls: Array<{ channel: string; headless: boolean; args: string[] }>;
  contextCalls: Array<Record<string, unknown>>;
  routeSelectors: string[];
  setContentCalls: string[];
  gotoCalls: number;
  screenshotCalls: Array<Record<string, unknown>>;
  /** How many times the tool measured the layout before shooting. */
  evaluateCalls: number;
  /** What the fake reports as the document height, in CSS px. */
  contentHeight: number;
  closeCount: number;
  contextCloseCount: number;
  /** Resolve this to let a blocked launch proceed. */
  launchGate: null | (() => Promise<void>);
  /** Resolve this to let a blocked screenshot proceed. */
  screenshotGate: null | (() => Promise<void>);
  /**
   * Resolve this to let a blocked `browser.close()` proceed. The engine closes
   * the browser in its `finally`, which is an await — the one window where an
   * abort can land AFTER the PNG came back but BEFORE the tool writes it.
   */
  closeGate: null | (() => Promise<void>);
  png: Buffer;
  launchError: string | undefined;
  screenshotError: string | undefined;
}

export const renderFake: RenderFake = {
  launchCalls: [],
  contextCalls: [],
  routeSelectors: [],
  setContentCalls: [],
  gotoCalls: 0,
  screenshotCalls: [],
  evaluateCalls: 0,
  contentHeight: 1_024,
  closeCount: 0,
  contextCloseCount: 0,
  launchGate: null,
  screenshotGate: null,
  closeGate: null,
  png: Buffer.alloc(0),
  launchError: undefined,
  screenshotError: undefined,
};

export function resetRenderFake(): void {
  renderFake.launchCalls = [];
  renderFake.contextCalls = [];
  renderFake.routeSelectors = [];
  renderFake.setContentCalls = [];
  renderFake.gotoCalls = 0;
  renderFake.screenshotCalls = [];
  renderFake.evaluateCalls = 0;
  renderFake.contentHeight = 1_024;
  renderFake.closeCount = 0;
  renderFake.contextCloseCount = 0;
  renderFake.launchGate = null;
  renderFake.screenshotGate = null;
  renderFake.closeGate = null;
  renderFake.png = pngWith(1024, 1024);
  renderFake.launchError = undefined;
  renderFake.screenshotError = undefined;
}

/** The stub module `getPlaywright()` is mocked to return. */
export function fakePlaywright(): {
  chromium: {
    launch: (options: { channel: string; headless: boolean; args: string[] }) => Promise<unknown>;
  };
} {
  return {
    chromium: {
      launch: async (options: { channel: string; headless: boolean; args: string[] }) => {
        renderFake.launchCalls.push(options);
        if (renderFake.launchError) throw new Error(renderFake.launchError);
        if (renderFake.launchGate) await renderFake.launchGate();
        const instance = { closed: false };
        return {
          version: () => 'fake',
          newContext: async (contextOptions: Record<string, unknown>) => {
            renderFake.contextCalls.push(contextOptions);
            return {
              route: async (selector: string) => {
                renderFake.routeSelectors.push(selector);
              },
              newPage: async () => ({
                setContent: async (html: string) => {
                  renderFake.setContentCalls.push(html);
                },
                // The tool measures the document before a full_page capture.
                // The real page evaluates in the page's own context; here it
                // just reports the height the test asked for.
                evaluate: async () => {
                  renderFake.evaluateCalls += 1;
                  return renderFake.contentHeight;
                },
                screenshot: async (screenshotOptions: Record<string, unknown>) => {
                  renderFake.screenshotCalls.push(screenshotOptions);
                  if (renderFake.screenshotError) throw new Error(renderFake.screenshotError);
                  if (renderFake.screenshotGate) await renderFake.screenshotGate();
                  // Real page handles die with the browser, which is how an
                  // abort mid-render surfaces to the caller.
                  if (instance.closed) {
                    throw new Error('Target page, context or browser has been closed');
                  }
                  return renderFake.png;
                },
                goto: async () => {
                  renderFake.gotoCalls += 1;
                },
              }),
              close: async () => {
                renderFake.contextCloseCount += 1;
              },
            };
          },
          close: async () => {
            if (renderFake.closeGate) await renderFake.closeGate();
            renderFake.closeCount += 1;
            instance.closed = true;
          },
        };
      },
    },
  };
}

/**
 * A real-enough PNG: the tool reads width/height from the IHDR box, so the
 * header alone carries the dimensions the result text and the caps depend on.
 */
export function pngWith(width: number, height: number, extraBytes = 0): Buffer {
  const head = Buffer.alloc(24 + extraBytes);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12);
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return head;
}

/** The filename stamp `now: () => new Date('2026-10-03T12:34:56.789Z')` yields. */
export const STAMP = '20261003-123456';

/**
 * Sizes in tool messages go through `toLocaleString()`, whose separator is
 * locale-dependent (this machine renders 1,048,576 as 1.048.576). Stripping
 * everything but digits lets a test assert the number without pinning a locale.
 */
export function digits(text: string): string {
  return text.replace(/[^\d]/g, '');
}
