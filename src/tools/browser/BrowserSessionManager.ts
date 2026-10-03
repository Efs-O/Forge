import type { Browser, BrowserContext, Page } from 'playwright-core';

/**
 * The configured system browser channel (plan §4.1). Used as-is — no silent
 * fallback (Claude condition 2): if the configured channel's browser is not
 * installed, `launch` throws naming the alternative. `chromium` (Playwright's
 * downloaded build) is a last resort requiring a manual user-run install.
 */
export type BrowserChannel = 'chrome' | 'msedge' | 'chromium';

export interface BrowserSessionOptions {
  channel: BrowserChannel;
  /** A config value (browser.headless), never a model arg. */
  headless: boolean;
}

/** One tab as reported to the model. */
export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  active: boolean;
}

/** A raw screenshot: PNG bytes plus its true dimensions (for the text). */
export interface BrowserScreenshot {
  png: Buffer;
  width: number;
  height: number;
}

/** A numbered interactive element from `browser_inspect` (heuristic, not the a11y tree). */
export interface BrowserElement {
  index: number;
  role: string;
  text: string;
  bbox: { x: number; y: number; width: number; height: number };
  /** A CSS selector that re-selects this element (best-effort, DOM-stable). */
  selector: string;
}

/**
 * Bounded capture size. `deviceScaleFactor: 1` makes CSS px == device px, so a
 * viewport screenshot is exactly VIEWPORT_WIDTH × VIEWPORT_HEIGHT and image
 * coordinates equal the CSS coordinates `page.mouse` uses (plan §4.3).
 */
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 800;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

/**
 * Heuristic interactive-element selector for `browser_inspect` (plan §4.2): a
 * numbered target list, NOT the full accessibility tree (a non-goal).
 */
const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[onclick]',
  '[contenteditable="true"]',
  'summary',
].join(',');

/**
 * Lazily load playwright-core. It is 12.8 MB and external (shipped intact in
 * dist/node_modules, NOT inlined by esbuild — B4: inlining breaks its runtime
 * file lookups). Requiring it at module top would load it on every activation,
 * even for users who never enable the browser; it loads only when a session is
 * launched. Node caches the require, so repeat calls are cheap.
 *
 * Exported because `render_html_to_image` needs the same lazy require without
 * duplicating the 12.8 MB import rule — a second copy is a second place to get
 * B4 wrong. It does NOT imply the `permissions.browser.enabled` gate: that gate
 * is for interactive browsing, and the render tool is exempt by owner decision
 * (docs/plans/SEND_FILE_AND_RENDER_HTML_PLAN.md).
 */
export function getPlaywright(): typeof import('playwright-core') {
  // Deliberate lazy require: playwright-core is external (shipped intact in
  // dist/node_modules) and must not load at module top (12.8 MB on every
  // activation). See B4.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('playwright-core') as typeof import('playwright-core');
}

/** A real web origin (http/https) — the only kind that has an exfil surface. */
export function webOriginOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
    return undefined; // about:blank, data:, chrome:, file:, …
  } catch {
    return undefined;
  }
}

/**
 * True PNG dimensions from the IHDR box (no full decode needed). Exported for
 * `render_html_to_image`, which reports the size of the PNG it just made and
 * caps a `full_page` capture by its real height; a second copy of this reader
 * is a second place to get the IHDR offset wrong.
 */
export function pngDimensions(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24) return { width: 0, height: 0 };
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * Owns the one explicit browser session (plan §4.5): a fresh ephemeral
 * `BrowserContext` on a system channel — never the user's Chrome profile, never
 * attached to existing tabs, never `connectOverCDP` to a running browser.
 *
 * The manager is the single owner of the Playwright objects; the tool handlers
 * are thin wrappers that validate args, do origin-approval bookkeeping, and
 * format the (multimodal) result. It is `vscode`-free on purpose: the smoke
 * bundles this entry with the extension's esbuild options and runs it under
 * plain node, where `vscode` is not provided.
 */
export class BrowserSessionManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private readonly tabIds = new Map<Page, string>();
  private nextTab = 1;
  private activePage: Page | null = null;
  private readonly approvedOrigins = new Set<string>();

  constructor(preApprovedOrigins: readonly string[] = []) {
    for (const origin of preApprovedOrigins) this.approvedOrigins.add(origin);
  }

  isLaunched(): boolean {
    return this.browser !== null;
  }

  /** Origins already approved this session (for the approval() closures). */
  isOriginApproved(origin: string): boolean {
    return this.approvedOrigins.has(origin);
  }

  /** Record an origin as approved after a successful action on it. */
  markOriginApproved(origin: string): void {
    this.approvedOrigins.add(origin);
  }

  /**
   * Launch the configured system browser and create the fresh ephemeral
   * context. Returns the browser version. Throws a message naming the
   * alternative when the channel is absent (no silent fallback).
   */
  async launch(opts: BrowserSessionOptions): Promise<{ version: string }> {
    if (this.browser) {
      throw new Error('BrowserSessionManager: already launched; call close() first');
    }
    const { chromium } = getPlaywright();
    let browser: Browser;
    try {
      browser = await chromium.launch({ channel: opts.channel, headless: opts.headless });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `browser_open: ${opts.channel} could not be launched (${msg}). ` +
          `Set browser.channel to an installed browser (chrome | msedge). No silent fallback.`,
      );
    }
    this.browser = browser;
    this.context = await browser.newContext({
      viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
      deviceScaleFactor: 1,
    });
    this.context.on('page', (page) => this.adoptPage(page));
    return { version: browser.version() };
  }

  /** Close the browser (throwaway profile gone). Idempotent. */
  async close(): Promise<void> {
    if (!this.browser) return;
    const browser = this.browser;
    this.browser = null;
    this.context = null;
    this.activePage = null;
    this.tabIds.clear();
    this.nextTab = 1;
    await browser.close();
  }

  private adoptPage(page: Page): void {
    if (!this.tabIds.has(page)) {
      this.tabIds.set(page, `t${this.nextTab++}`);
      if (!this.activePage) this.activePage = page;
    }
    page.on('close', () => {
      this.tabIds.delete(page);
      if (this.activePage === page) {
        const remaining = this.context?.pages() ?? [];
        this.activePage = remaining[remaining.length - 1] ?? null;
      }
    });
  }

  private pageById(tabId: string): Page | undefined {
    for (const [page, id] of this.tabIds) if (id === tabId) return page;
    return undefined;
  }

  /** Resolve the target page: the named tab, or the active one. */
  private async resolvePage(tabId?: string): Promise<Page> {
    if (!this.context) throw new Error('browser session expired; call browser_open again');
    if (tabId) {
      const page = this.pageById(tabId);
      if (!page) throw new Error(`browser: no tab "${tabId}" (see browser_tabs)`);
      return page;
    }
    if (!this.activePage) throw new Error('browser: no active tab; call browser_new_tab');
    return this.activePage;
  }

  private async tabInfo(page: Page): Promise<BrowserTab> {
    const id = this.tabIds.get(page) ?? '?';
    let title = '';
    let url = '';
    try {
      title = await page.title();
    } catch {
      /* page may be mid-navigation */
    }
    url = page.url();
    return { id, title, url, active: page === this.activePage };
  }

  /** Create a new tab (and navigate if a url is given). Returns the tab. */
  async newPage(url?: string): Promise<BrowserTab> {
    if (!this.context) throw new Error('browser session expired; call browser_open again');
    const page = await this.context.newPage();
    this.adoptPage(page);
    this.activePage = page;
    if (url) await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    return this.tabInfo(page);
  }

  async tabs(): Promise<BrowserTab[]> {
    if (!this.context) return [];
    const pages = this.context.pages();
    return Promise.all(pages.map((page) => this.tabInfo(page)));
  }

  async selectTab(tabId: string): Promise<BrowserTab> {
    const page = await this.resolvePage(tabId);
    this.activePage = page;
    await page.bringToFront();
    return this.tabInfo(page);
  }

  async closeTab(tabId: string): Promise<void> {
    const page = this.pageById(tabId);
    if (!page) throw new Error(`browser: no tab "${tabId}" (see browser_tabs)`);
    await page.close();
  }

  /**
   * The URL of the tab an input tool will act on — the named tab, else the
   * active one (for origin-approval). Undefined when that tab does not exist.
   */
  tabUrl(tabId?: string): string | undefined {
    return (tabId ? this.pageById(tabId) : this.activePage)?.url();
  }

  async navigate(tabId: string | undefined, url: string): Promise<BrowserTab> {
    const page = await this.resolvePage(tabId);
    this.activePage = page;
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    return this.tabInfo(page);
  }

  /** Viewport (fullPage=false) or full-page screenshot of the target tab. */
  async screenshot(tabId: string | undefined, fullPage: boolean): Promise<BrowserScreenshot> {
    const page = await this.resolvePage(tabId);
    this.activePage = page;
    const png = await page.screenshot({ fullPage, type: 'png' });
    if (png.length > MAX_SCREENSHOT_BYTES) {
      throw new Error(
        `browser_screenshot: image too large (${png.length.toLocaleString()} bytes; max ${MAX_SCREENSHOT_BYTES.toLocaleString()}).`,
      );
    }
    return { png, ...pngDimensions(png) };
  }

  /** Numbered interactive elements with bboxes + a re-selectable selector. */
  async inspect(tabId: string | undefined, max: number): Promise<BrowserElement[]> {
    const page = await this.resolvePage(tabId);
    // String-based evaluate: the body runs in the browser (DOM globals like
    // document/CSS) but is type-checked against the Node lib here, which has no
    // DOM. A string sidesteps that. page.evaluate takes one arg, so pass an object.
    return page.evaluate<BrowserElement[]>(
      `(obj) => {
        const els = Array.from(document.querySelectorAll(obj.selector));
        return els.slice(0, obj.limit).map((el, index) => {
          const rect = el.getBoundingClientRect();
          const role = el.getAttribute('role') ?? (el.tagName === 'A' ? 'link' : el.tagName === 'INPUT' ? (el.getAttribute('type') ?? 'input') : el.tagName.toLowerCase());
          const text = (el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.textContent ?? el.getAttribute('placeholder') ?? el.getAttribute('value') ?? '').trim().slice(0, 80);
          let sel;
          if (el.id) sel = '#' + CSS.escape(el.id);
          else {
            const tag = el.tagName.toLowerCase();
            let n = 1;
            for (let sib = el.previousElementSibling; sib; sib = sib.previousElementSibling) { if (sib.tagName === el.tagName) n++; }
            sel = tag + ':nth-of-type(' + n + ')';
          }
          return { index, role, text, bbox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, selector: sel };
        });
      }`,
      { selector: INTERACTIVE_SELECTOR, limit: max },
    );
  }

  /** Click by selector, by inspect index (re-resolved), or by viewport coords. */
  async click(
    tabId: string | undefined,
    target: {
      selector?: string | undefined;
      index?: number | undefined;
      x?: number | undefined;
      y?: number | undefined;
    },
  ): Promise<string> {
    const page = await this.resolvePage(tabId);
    if (target.selector) {
      await page.locator(target.selector).first().click();
      return `clicked "${target.selector}"`;
    }
    if (target.index !== undefined) {
      const els = await this.inspect(tabId, target.index + 1);
      const el = els[target.index];
      if (!el)
        throw new Error(`browser_click: no element at index ${target.index} (see browser_inspect)`);
      const x = el.bbox.x + el.bbox.width / 2;
      const y = el.bbox.y + el.bbox.height / 2;
      await page.mouse.click(x, y);
      return `clicked element ${target.index} ("${el.text || el.role}") at ${Math.round(x)},${Math.round(y)}`;
    }
    if (target.x !== undefined && target.y !== undefined) {
      await page.mouse.click(target.x, target.y);
      return `clicked at ${target.x},${target.y} (viewport px)`;
    }
    throw new Error('browser_click: provide selector, index, or x+y');
  }

  async type(
    tabId: string | undefined,
    target: { selector?: string | undefined; index?: number | undefined },
    text: string,
  ): Promise<string> {
    const page = await this.resolvePage(tabId);
    if (target.selector) {
      await page.locator(target.selector).first().fill(text);
      return `typed into "${target.selector}"`;
    }
    if (target.index !== undefined) {
      const els = await this.inspect(tabId, target.index + 1);
      const el = els[target.index];
      if (!el)
        throw new Error(`browser_type: no element at index ${target.index} (see browser_inspect)`);
      const x = el.bbox.x + el.bbox.width / 2;
      const y = el.bbox.y + el.bbox.height / 2;
      await page.mouse.click(x, y);
      await page.keyboard.type(text);
      return `typed into element ${target.index} ("${el.text || el.role}")`;
    }
    throw new Error('browser_type: provide selector or index');
  }

  async press(tabId: string | undefined, key: string, selector?: string): Promise<string> {
    const page = await this.resolvePage(tabId);
    if (selector) {
      await page.locator(selector).first().press(key);
      return `pressed "${key}" on "${selector}"`;
    }
    await page.keyboard.press(key);
    return `pressed "${key}"`;
  }

  async scroll(
    tabId: string | undefined,
    target: { selector?: string | undefined; x?: number | undefined; y?: number | undefined },
    deltaX: number,
    deltaY: number,
  ): Promise<string> {
    const page = await this.resolvePage(tabId);
    if (target.selector) {
      await page
        .locator(target.selector)
        .first()
        .evaluate('(el, d) => { el.scrollBy(d.dx, d.dy); }', { dx: deltaX, dy: deltaY });
      return `scrolled "${target.selector}" by ${deltaX},${deltaY}`;
    }
    const x = target.x ?? VIEWPORT_WIDTH / 2;
    const y = target.y ?? VIEWPORT_HEIGHT / 2;
    await page.mouse.move(x, y);
    await page.mouse.wheel(deltaX, deltaY);
    return `scrolled by ${deltaX},${deltaY} at ${x},${y}`;
  }

  async hover(
    tabId: string | undefined,
    target: {
      selector?: string | undefined;
      index?: number | undefined;
      x?: number | undefined;
      y?: number | undefined;
    },
  ): Promise<string> {
    const page = await this.resolvePage(tabId);
    if (target.selector) {
      await page.locator(target.selector).first().hover();
      return `hovered "${target.selector}"`;
    }
    if (target.x !== undefined && target.y !== undefined) {
      await page.mouse.move(target.x, target.y);
      return `hovered at ${target.x},${target.y}`;
    }
    if (target.index !== undefined) {
      const els = await this.inspect(tabId, target.index + 1);
      const el = els[target.index];
      if (!el) throw new Error(`browser_hover: no element at index ${target.index}`);
      await page.mouse.move(el.bbox.x + el.bbox.width / 2, el.bbox.y + el.bbox.height / 2);
      return `hovered element ${target.index}`;
    }
    throw new Error('browser_hover: provide selector, index, or x+y');
  }

  async drag(
    tabId: string | undefined,
    from: { x: number; y: number },
    to: { x: number; y: number },
  ): Promise<string> {
    const page = await this.resolvePage(tabId);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 10 });
    await page.mouse.up();
    return `dragged ${from.x},${from.y} → ${to.x},${to.y}`;
  }
}

/**
 * Process-wide singleton (plan §4.5): one Chrome process, many tabs. The tool
 * factory and `extension.ts` `deactivate()` both reach for the same instance so
 * the browser is closed exactly once on window close. `vscode`-free.
 */
let singleton: BrowserSessionManager | null = null;
export function getBrowserSessionManager(
  preApproved: readonly string[] = [],
): BrowserSessionManager {
  if (!singleton) singleton = new BrowserSessionManager(preApproved);
  return singleton;
}
/**
 * Window-close shutdown (plan §4.5): closes the browser exactly once. A failed
 * close is reported to `onError`, never swallowed; a no-op if never launched.
 */
export async function closeBrowserSessionOnShutdown(
  onError: (err: unknown) => void,
): Promise<void> {
  if (!singleton) return;
  await singleton.close().catch(onError);
}
/** Test seam: replace the singleton with a fake. */
export function setBrowserSessionManagerForTest(mgr: BrowserSessionManager | null): void {
  singleton = mgr;
}
