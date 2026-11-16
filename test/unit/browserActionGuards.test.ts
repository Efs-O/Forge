/**
 * Unit tests for the stateless browser action guards (fix-plan Phase 3 item 1,
 * and the Phase 1 coordinate bound moved into this module).
 *
 * No browser and no Playwright transport: these pin the rule itself — the
 * 5,000 ms bound, the viewport refusal text, and the fact that a failed action
 * is named and its cause preserved rather than converted to success or retried.
 */
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  LOCATOR_ACTION_TIMEOUT_MS,
  requireViewportPoint,
  withLocatorActionTimeout,
} from '../../src/tools/browser/browserActionGuards';
import { makeBrowserActionTools } from '../../src/tools/browser/browserActionTools';
import type { BrowserToolContext } from '../../src/tools/browser/browserTools';
import type { MultimodalToolResult } from '../../src/tools/ToolRegistry';

describe('locator action bound (Phase 3 item 1)', () => {
  it('is 5,000 ms — the documented bound, not Playwright\'s 30 s default', () => {
    expect(LOCATOR_ACTION_TIMEOUT_MS).toBe(5000);
  });

  it('names the tool, action, and target when an action fails', async () => {
    await expect(
      withLocatorActionTimeout('click', 'selector "#gone"', async () => {
        throw new Error('locator.click: Timeout 5000ms exceeded');
      }),
    ).rejects.toThrow(
      /browser_click: selector "#gone" failed within 5000 ms \(locator\.click: Timeout 5000ms exceeded\)/,
    );
  });

  it('preserves the Playwright cause on the error object', async () => {
    const original = new Error('locator.fill: Timeout 5000ms exceeded');
    let caught: unknown;
    try {
      await withLocatorActionTimeout('type', 'selector "#q"', async () => {
        throw original;
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    // The cause is the SAME object, so a caller can still inspect the original
    // stack/name — the plan requires the cause be preserved, not paraphrased.
    expect((caught as Error).cause).toBe(original);
  });

  it('passes a non-timeout failure through named as well', async () => {
    // A strict-mode "resolved to 3 elements" error is not a timeout, and must
    // still be attributed to the tool and selector that produced it.
    await expect(
      withLocatorActionTimeout('hover', 'selector "#dup"', async () => {
        throw new Error('Error: strict mode violation');
      }),
    ).rejects.toThrow(/browser_hover: selector "#dup" failed within 5000 ms.*strict mode violation/);
  });

  it('never retries and never converts a failure into success', async () => {
    let calls = 0;
    await expect(
      withLocatorActionTimeout('click', 'selector "#x"', async () => {
        calls += 1;
        throw new Error('boom');
      }),
    ).rejects.toThrow(/boom/);
    expect(calls).toBe(1);
  });

  it('returns the action result unchanged on success', async () => {
    expect(await withLocatorActionTimeout('click', 'selector "#x"', async () => 'done')).toBe(
      'done',
    );
  });
});

describe('viewport point bound (Phase 1, report §3.8)', () => {
  const vp = { width: 1280, height: 800 };

  it('accepts points inside the viewport, including the edges 0 and size-1', () => {
    for (const [x, y] of [
      [0, 0],
      [1279, 799],
      [640, 400],
    ] as const) {
      expect(() => requireViewportPoint(vp, x, y, 'browser_click')).not.toThrow();
    }
  });

  it('refuses out-of-viewport, negative, and non-finite points', () => {
    for (const [x, y] of [
      [1280, 10], // one past the right edge
      [10, 800], // one past the bottom edge
      [-1, 10],
      [10, -1],
      [5000, 5000],
      [Number.NaN, 10],
      [10, Number.POSITIVE_INFINITY],
    ] as const) {
      expect(() => requireViewportPoint(vp, x, y, 'browser_scroll')).toThrow(
        /outside the 1280×800 viewport/,
      );
    }
  });

  it('names the point, the viewport, and the valid range', () => {
    try {
      requireViewportPoint(vp, 5000, 5000, 'browser_click');
      expect.unreachable('expected a refusal');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('(5000,5000)');
      expect(msg).toContain('1280×800');
      expect(msg).toContain('valid x: 0-1279');
      expect(msg).toContain('y: 0-799');
      expect(msg).toMatch(/browser_inspect/);
    }
  });

  it('checks against the viewport it is given, so a resized context is honoured', () => {
    expect(() => requireViewportPoint({ width: 400, height: 300 }, 500, 10, 'a')).toThrow(
      /outside the 400×300 viewport/,
    );
  });
});

/**
 * `browser_screenshot` lists the tabs AFTER the capture, so the tab can close in
 * between and the list comes back empty. The PNG is still real: the line must
 * say whose tab it was instead of throwing over a tab that is no longer there.
 */
function screenshotTool(mgr: Record<string, ReturnType<typeof vi.fn>>) {
  const context = {
    mgr,
    inputApproval: () => () => undefined,
    markTargetOrigin: () => undefined,
    str: (args: Record<string, unknown>, key: string) =>
      typeof args[key] === 'string' ? (args[key] as string) : undefined,
  } as unknown as BrowserToolContext;
  const tool = makeBrowserActionTools(context).find(
    (candidate) => candidate.definition.function.name === 'browser_screenshot',
  );
  if (!tool) throw new Error('browser_screenshot was not registered');
  return tool;
}

describe('browser_screenshot tab naming', () => {
  const png = Buffer.from('89504e4d0d0a1a0a', 'hex');

  async function capture(tabs: unknown[]): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-browser-shot-'));
    process.env.FORGE_SCREENSHOT_DIR = dir;
    try {
      const tool = screenshotTool({
        screenshot: vi.fn(async () => ({ png, width: 1280, height: 720 })),
        tabs: vi.fn(async () => tabs),
      });
      const result = (await tool.handler({})) as MultimodalToolResult;
      return result.text;
    } finally {
      delete process.env.FORGE_SCREENSHOT_DIR;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('names the closed tab when no tab is listed', async () => {
    expect(await capture([])).toMatch(/^Screenshot of the closed tab, 1280×720 px, /u);
  });

  it('names the live tab when one is listed', async () => {
    const text = await capture([{ id: 't1', title: 'Example', url: 'https://x.test', active: true }]);
    expect(text.startsWith('Screenshot of tab t1 ("Example"), 1280×720 px, ')).toBe(true);
  });
});
