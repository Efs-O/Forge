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
