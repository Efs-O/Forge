import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ launchPersistentContext: vi.fn() }));

vi.mock('../../src/tools/browser/browserPrimitives', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/tools/browser/browserPrimitives')>()),
  getPlaywright: () => ({ chromium: { launchPersistentContext: mocks.launchPersistentContext } }),
}));

import { BrowserSessionManager } from '../../src/tools/browser/BrowserSessionManager';

/**
 * A throwaway profile is now one call: `launchPersistentContext` answers with
 * the context it opened on that profile (a persistent context IS its own
 * context), so the fake is a context — with the `browser()` the version comes
 * from and the `close()` that removes the profile.
 */
function launchFakeContext() {
  const context = {
    on: vi.fn(),
    pages: () => [],
    close: vi.fn(async () => undefined),
    browser: () => ({ version: () => 'test-browser' }),
  };
  return { context };
}

describe('BrowserSessionManager lifecycle', () => {
  afterEach(() => vi.restoreAllMocks());

  it('forgets session approvals on close and keeps configured pre-approvals', async () => {
    const { context } = launchFakeContext();
    mocks.launchPersistentContext.mockResolvedValue(context);
    const manager = new BrowserSessionManager(['https://configured.example']);
    await manager.launch({ channel: 'chrome', headless: true });
    manager.markOriginApproved('https://session.example');

    // The bounded viewport used to go to `browser.newContext`; a persistent
    // context takes the same options on the launch that opens it.
    expect(mocks.launchPersistentContext).toHaveBeenCalledWith(
      expect.stringContaining('forge-browser-'),
      expect.objectContaining({
        channel: 'chrome',
        headless: true,
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
      }),
    );

    await manager.close();

    expect(context.close).toHaveBeenCalledOnce();
    expect(manager.isOriginApproved('https://configured.example')).toBe(true);
    expect(manager.isOriginApproved('https://session.example')).toBe(false);
  });

  it('names the config fix and rolls back launch state when the profile cannot be launched', async () => {
    mocks.launchPersistentContext.mockRejectedValue(new Error('profile creation failed'));
    const manager = new BrowserSessionManager();

    await expect(manager.launch({ channel: 'chrome', headless: true })).rejects.toThrow(
      'browser_open: chrome could not be launched (profile creation failed). ' +
        'Set browser.channel to an installed browser (chrome | msedge). No silent fallback.',
    );

    expect(manager.isLaunched()).toBe(false);
  });

  // A persistent context opens with one blank page already in `pages()`: it
  // must be adopted, or the tab the user can see is invisible to every tool.
  it('adopts the page the persistent context opened with', async () => {
    const page = { on: vi.fn(), url: () => 'about:blank', title: async () => '' };
    const context = { ...launchFakeContext().context, pages: () => [page] };
    mocks.launchPersistentContext.mockResolvedValue(context);
    const manager = new BrowserSessionManager();

    await manager.launch({ channel: 'chrome', headless: true });

    expect(page.on).toHaveBeenCalledWith('close', expect.any(Function));
    expect(await manager.tabs()).toHaveLength(1);
    await manager.close();
  });

  // `adoptPage` runs on both `newPage` and the context's own `page` event, so a
  // tab can be adopted twice; a second `close` listener would run the same
  // page's bookkeeping twice.
  it('registers one close listener per page, even when a page is adopted twice', async () => {
    const { context } = launchFakeContext();
    mocks.launchPersistentContext.mockResolvedValue(context);
    const page = { on: vi.fn() };
    const manager = new BrowserSessionManager();
    await manager.launch({ channel: 'chrome', headless: true });
    const adopt = context.on.mock.calls
      .find((call) => call[0] === 'page')
      ?.at(1) as (adopted: unknown) => void;
    adopt(page);
    adopt(page);
    const events = page.on.mock.calls.map((call) => call[0]);
    expect(events.filter((event) => event === 'close')).toHaveLength(1);
    expect(events.filter((event) => event === 'framenavigated')).toHaveLength(1);
    await manager.close();
  });
});

describe('BrowserSessionManager scroll into view', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses Playwright scrollIntoViewIfNeeded for selectors and inspected indexes', async () => {
    const facts = {
      role: null,
      tag: 'button',
      type: null,
      ariaLabel: null,
      title: null,
      textContent: 'Target',
      placeholder: null,
      value: null,
      contentEditable: null,
      readOnly: false,
      disabled: false,
    };
    const handle = {
      evaluate: vi.fn(async () => ({ attached: true, visible: true, facts })),
      scrollIntoViewIfNeeded: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    };
    const locator = {
      first: vi.fn(() => locator),
      scrollIntoViewIfNeeded: vi.fn(async () => undefined),
    };
    const frame = {};
    const page = {
      on: vi.fn(),
      mainFrame: () => frame,
      url: () => 'https://example.test/',
      title: async () => 'Example',
      locator: vi.fn(() => locator),
      evaluate: vi.fn(async () => [
        {
          index: 0,
          selector: 'button:nth-of-type(1)',
          bbox: { x: 0, y: 0, width: 10, height: 10 },
          facts,
        },
      ]),
      evaluateHandle: vi.fn(async () => ({
        getProperties: async () => new Map([['0', { asElement: () => handle }]]),
        dispose: vi.fn(async () => undefined),
      })),
    };
    const context = {
      on: vi.fn(),
      pages: () => [page],
      newPage: async () => page,
      close: vi.fn(async () => undefined),
      browser: () => ({ version: () => 'test-browser' }),
    };
    mocks.launchPersistentContext.mockResolvedValue(context);
    const manager = new BrowserSessionManager();
    await manager.launch({ channel: 'chrome', headless: true });
    await manager.newPage();

    await expect(manager.scrollIntoView(undefined, { selector: '#target' })).resolves.toBe(
      'scrolled "#target" into view',
    );
    expect(locator.scrollIntoViewIfNeeded).toHaveBeenCalledExactlyOnceWith({ timeout: 5000 });

    await manager.inspect(undefined, undefined);
    await expect(manager.scrollIntoView(undefined, { index: 0 })).resolves.toBe(
      'scrolled element 0 ("Target") into view',
    );
    expect(handle.scrollIntoViewIfNeeded).toHaveBeenCalledExactlyOnceWith({ timeout: 5000 });
    expect(handle.evaluate).toHaveBeenCalledOnce();
    await manager.close();
  });
});
