import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ launch: vi.fn() }));

vi.mock('../../src/tools/browser/browserPrimitives', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/tools/browser/browserPrimitives')>()),
  getPlaywright: () => ({ chromium: { launch: mocks.launch } }),
}));

import { BrowserSessionManager } from '../../src/tools/browser/BrowserSessionManager';

function browserWithContext() {
  const context = { on: vi.fn(), pages: () => [] };
  const browser = {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => undefined),
    version: () => 'test-browser',
  };
  return { browser, context };
}

describe('BrowserSessionManager lifecycle', () => {
  afterEach(() => vi.restoreAllMocks());

  it('forgets session approvals on close and keeps configured pre-approvals', async () => {
    const { browser } = browserWithContext();
    mocks.launch.mockResolvedValue(browser);
    const manager = new BrowserSessionManager(['https://configured.example']);
    await manager.launch({ channel: 'chrome', headless: true });
    manager.markOriginApproved('https://session.example');

    await manager.close();

    expect(manager.isOriginApproved('https://configured.example')).toBe(true);
    expect(manager.isOriginApproved('https://session.example')).toBe(false);
  });

  it('closes the browser and rolls back launch state when context creation fails', async () => {
    const { browser } = browserWithContext();
    browser.newContext.mockRejectedValue(new Error('profile creation failed'));
    mocks.launch.mockResolvedValue(browser);
    const manager = new BrowserSessionManager();

    await expect(manager.launch({ channel: 'chrome', headless: true })).rejects.toThrow(
      'profile creation failed',
    );

    expect(browser.close).toHaveBeenCalledOnce();
    expect(manager.isLaunched()).toBe(false);
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
    };
    const browser = {
      newContext: async () => context,
      close: vi.fn(async () => undefined),
      version: () => 'test-browser',
    };
    mocks.launch.mockResolvedValue(browser);
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
  });
});
