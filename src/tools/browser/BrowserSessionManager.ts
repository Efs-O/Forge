import type { Browser, BrowserContext, Page } from 'playwright-core';
import { InspectionStore } from './browserInspectionStore';
import type { BrowserElement, IndexTarget } from './browserInspect';
import { getPlaywright, pngDimensions } from './browserPrimitives';
import {
  LOCATOR_ACTION_TIMEOUT_MS,
  requireViewportPoint,
  withLocatorActionTimeout,
} from './browserActionGuards';
import { typeIntoLocator, typeIntoTarget } from './browserTextInput';
import type { BrowserChannel, BrowserScreenshot } from './browserPrimitives';
export {
  DEFAULT_INSPECT_MAX,
  MAX_INSPECT_ELEMENTS,
  clampInspectMax,
  type BrowserElement,
} from './browserInspect';
// Re-exported so existing import sites — `renderEngine`, `renderHtmlToImageTool`,
// `browserTools`, and the `vi.mock` seam the render tests use on THIS module —
// keep working after the primitives moved to `browserPrimitives.ts`.
export {
  getPlaywright,
  pngDimensions,
  webOriginOf,
  type BrowserChannel,
  type BrowserScreenshot,
} from './browserPrimitives';

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

/** A numbered interactive element from `browser_inspect` (heuristic, not the a11y tree)
 *  is declared once, in `browserInspect.ts`, and re-exported at the top of this file. */

/**
 * Bounded capture size. `deviceScaleFactor: 1` makes CSS px == device px, so a
 * viewport screenshot is exactly VIEWPORT_WIDTH × VIEWPORT_HEIGHT and image
 * coordinates equal the CSS coordinates `page.mouse` uses (plan §4.3).
 */
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 800;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

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
  /**
   * The last inspection of each tab (fix plan Phase 1). `browser_click`,
   * `browser_type`, and `browser_hover` must act on the node the user was shown,
   * not on whatever re-enumeration happens to put at that number now. The
   * manager is its only owner; the store holds no session state of its own.
   */
  private readonly inspections = new InspectionStore();
  /** Pages whose main-frame navigation listener is already installed. */
  private readonly frameListeners = new WeakSet<Page>();

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
    this.inspections.dropAll();
    await browser.close();
  }

  private adoptPage(page: Page): void {
    if (!this.tabIds.has(page)) {
      this.tabIds.set(page, `t${this.nextTab++}`);
      if (!this.activePage) this.activePage = page;
    }
    // A main-frame navigation is a new document: every retained node in this
    // tab's snapshot is gone, so the snapshot must go with it rather than
    // linger and match a same-URL coincidence.
    if (!this.frameListeners.has(page)) {
      this.frameListeners.add(page);
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) this.inspections.drop(page);
      });
    }
    page.on('close', () => {
      this.tabIds.delete(page);
      this.inspections.drop(page);
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

  /**
   * Numbered interactive elements with bboxes + a re-selectable selector, and
   * the snapshot the index actions are bound to. An empty page returns `[]`; an
   * unexpected non-array result is a named error, never a silent empty list.
   */
  async inspect(tabId: string | undefined, max: unknown): Promise<BrowserElement[]> {
    const page = await this.resolvePage(tabId);
    return this.inspections.capture(page, max);
  }

  /** Resolve an inspect index to the same, still-live node it named. */
  private async indexTarget(page: Page, index: number, action: string): Promise<IndexTarget> {
    return this.inspections.resolve(page, index, action);
  }

  /**
   * TEST SEAM ONLY — no tool calls this. Integration tests need to set up and
   * read page state (inject a sibling, count a click handler, read a value)
   * without a production tool whose job is to run arbitrary page script.
   * Resolves the tab like every other action and forwards to `page.evaluate`.
   * The callback is serialized into the page exactly as a real one would be.
   */
  async pageEvalForTest<Arg = void, R = unknown>(
    pageFunction: ((arg: Arg) => R) | (() => R),
    arg?: Arg,
  ): Promise<R> {
    const page = await this.resolvePage(undefined);
    // Cast away the generic: this seam only forwards to `page.evaluate`, and
    // Playwright's `Unboxed<Arg>` parameter type cannot be satisfied by an
    // arbitrary caller-supplied generic.
    return page.evaluate(pageFunction as never, arg as never);
  }

  /** Click by selector, by inspect index (same node, rechecked), or by viewport coords. */
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
      await withLocatorActionTimeout('click', `selector "${target.selector}"`, () =>
        page.locator(target.selector!).first().click({ timeout: LOCATOR_ACTION_TIMEOUT_MS }),
      );
      return `clicked "${target.selector}"`;
    }
    if (target.index !== undefined) {
      const el = await this.indexTarget(page, target.index, 'click');
      await withLocatorActionTimeout(
        'click',
        `element ${target.index} ("${el.text || el.role}")`,
        () => el.handle.click({ timeout: LOCATOR_ACTION_TIMEOUT_MS }),
      );
      return `clicked element ${target.index} ("${el.text || el.role}")`;
    }
    if (target.x !== undefined && target.y !== undefined) {
      this.requireViewportPoint(page, target.x, target.y, 'browser_click');
      await page.mouse.click(target.x, target.y);
      return `clicked at ${target.x},${target.y} (viewport px)`;
    }
    throw new Error('browser_click: provide selector, index, or x+y');
  }

  /**
   * Viewport check for a coordinate action. The rule itself lives in
   * `browserActionGuards` (stateless, and unit-testable without a browser);
   * this only supplies the page's own viewport so a resized context is checked
   * against its real size, not the launch constant.
   */
  private requireViewportPoint(page: Page, x: number, y: number, action: string): void {
    const vp = page.viewportSize() ?? { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT };
    requireViewportPoint(vp, x, y, action);
  }

  async type(
    tabId: string | undefined,
    target: { selector?: string | undefined; index?: number | undefined },
    text: string,
  ): Promise<string> {
    const page = await this.resolvePage(tabId);
    if (target.selector) {
      // The mode decision lives in `browserTextInput`, not here: a `<select>`
      // addressed by selector needs option selection, and `fill` refuses it.
      return typeIntoLocator(page.locator(target.selector), text, target.selector);
    }
    if (target.index !== undefined) {
      const el = await this.indexTarget(page, target.index, 'type');
      // `fill` targets the node itself; a click-then-keyboard-type could land on
      // whatever the click actually hit. A dropdown takes the option path.
      return typeIntoTarget(el, text, target.index);
    }
    throw new Error('browser_type: provide selector or index');
  }

  async press(tabId: string | undefined, key: string, selector?: string): Promise<string> {
    const page = await this.resolvePage(tabId);
    if (selector) {
      // Selector-scoped press only: a bare keyboard press has no element to wait
      // on, so there is nothing to bound and no locator timeout to apply.
      await withLocatorActionTimeout('press', `selector "${selector}"`, () =>
        page.locator(selector).first().press(key, { timeout: LOCATOR_ACTION_TIMEOUT_MS }),
      );
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
      await withLocatorActionTimeout('scroll', `selector "${target.selector}"`, () =>
        page.locator(target.selector!).first().evaluate(
          '(el, d) => { el.scrollBy(d.dx, d.dy); }',
          { dx: deltaX, dy: deltaY },
          {
            timeout: LOCATOR_ACTION_TIMEOUT_MS,
          },
        ),
      );
      return `scrolled "${target.selector}" by ${deltaX},${deltaY}`;
    }
    const x = target.x ?? VIEWPORT_WIDTH / 2;
    const y = target.y ?? VIEWPORT_HEIGHT / 2;
    this.requireViewportPoint(page, x, y, 'browser_scroll');
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
      await withLocatorActionTimeout('hover', `selector "${target.selector}"`, () =>
        page.locator(target.selector!).first().hover({ timeout: LOCATOR_ACTION_TIMEOUT_MS }),
      );
      return `hovered "${target.selector}"`;
    }
    if (target.x !== undefined && target.y !== undefined) {
      this.requireViewportPoint(page, target.x, target.y, 'browser_hover');
      await page.mouse.move(target.x, target.y);
      return `hovered at ${target.x},${target.y}`;
    }
    if (target.index !== undefined) {
      const el = await this.indexTarget(page, target.index, 'hover');
      await withLocatorActionTimeout(
        'hover',
        `element ${target.index} ("${el.text || el.role}")`,
        () => el.handle.hover({ timeout: LOCATOR_ACTION_TIMEOUT_MS }),
      );
      return `hovered element ${target.index} ("${el.text || el.role}")`;
    }
    throw new Error('browser_hover: provide selector, index, or x+y');
  }

  async drag(
    tabId: string | undefined,
    from: { x: number; y: number },
    to: { x: number; y: number },
  ): Promise<string> {
    const page = await this.resolvePage(tabId);
    this.requireViewportPoint(page, from.x, from.y, 'browser_drag');
    this.requireViewportPoint(page, to.x, to.y, 'browser_drag');
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
