import { afterAll, describe, expect, it } from 'vitest';
import type { ForgeConfig } from '../../src/config/types';
import { BrowserSessionManager } from '../../src/tools/browser/BrowserSessionManager';
import { makeBrowserActionTools } from '../../src/tools/browser/browserActionTools';
import {
  buildBrowserToolContext,
  makeBrowserSessionTools,
} from '../../src/tools/browser/browserTools';
import type { MultimodalToolResult, RegisteredTool } from '../../src/tools/ToolRegistry';

/**
 * Phase 1 gate (plan §5): a deterministic browser loop — browser_open →
 * browser_screenshot (assert the multimodal shape) → browser_click (a known
 * element) → browser_screenshot (assert the visible state changed). Runs real
 * headless Chrome on the configured system channel; skips with a message where
 * no browser is present (CI on a box without Chrome/Edge).
 *
 * A `data:` URL is used so the origin-approval gate never fires (a data: URL
 * has no origin), keeping the loop deterministic. The screenshot lands in the
 * real `~/.forge/screenshots/<conv>/` path by design (plan §4.3).
 */
const PAGE =
  'data:text/html,' +
  encodeURIComponent(
    '<html><body style="font:28px sans-serif;padding:24px">' +
      '<h1 id="h">Before click</h1>' +
      '<button id="btn" onclick="document.getElementById(\'h\').textContent=\'After click\'">Click me</button>' +
      '</body></html>',
  );

type HandlerCtx = Parameters<RegisteredTool['handler']>[1];
const toolCtx = { conversationId: 'browser-integration-test' } as unknown as HandlerCtx;

describe('browser tools: open → screenshot → click → screenshot (Phase 1 gate)', () => {
  const mgr = new BrowserSessionManager();
  const getConfig = (): ForgeConfig =>
    ({
      active_model: 'primary',
      llama_server: {},
      models: [{ name: 'primary', gguf_path: '/primary.gguf' }],
      browser: { channel: 'chrome', headless: true },
    }) as ForgeConfig;
  const ctx = buildBrowserToolContext(getConfig, mgr);
  const tools = new Map<string, RegisteredTool>(
    [...makeBrowserSessionTools(ctx), ...makeBrowserActionTools(ctx)].map((t) => [
      t.definition.function.name,
      t,
    ]),
  );

  const pngFromShot = (shot: MultimodalToolResult): Buffer => {
    const img = shot.content!.find((p) => p.type === 'image_url') as {
      image_url: { url: string };
    };
    return Buffer.from(img.image_url.url.split('base64,')[1], 'base64');
  };

  afterAll(async () => {
    await mgr.close().catch(() => undefined);
  });

  it('drives headless Chrome through the screenshot → click → screenshot loop', async (ctx) => {
    let openRes: string;
    try {
      openRes = (await tools
        .get('browser_open')!
        .handler({ url: PAGE }, toolCtx)) as string;
    } catch (err) {
      ctx.skip(`browser_open failed (no Chrome on this host?): ${(err as Error).message}`);
      return;
    }
    expect(openRes).toMatch(/Browser ready/);

    // browser_screenshot #1 — assert the multimodal shape (inline image + text).
    const shot1 = (await tools
      .get('browser_screenshot')!
      .handler({}, toolCtx)) as MultimodalToolResult;
    expect(shot1.content).toBeDefined();
    expect(shot1.text).toMatch(/coord_space=image_px/);
    expect(shot1.text).toMatch(/Saved to /);
    const img1 = shot1.content!.find((p) => p.type === 'image_url') as {
      image_url: { url: string };
    };
    expect(img1.image_url.url).toMatch(/^data:image\/png;base64,/);

    // browser_click — a known element (the button that rewrites the heading).
    const clickRes = (await tools
      .get('browser_click')!
      .handler({ selector: '#btn' }, toolCtx)) as string;
    expect(clickRes).toMatch(/clicked/);

    // browser_screenshot #2 — the visible state must have changed.
    const shot2 = (await tools
      .get('browser_screenshot')!
      .handler({}, toolCtx)) as MultimodalToolResult;
    expect(pngFromShot(shot1).equals(pngFromShot(shot2))).toBe(false);

    await tools.get('browser_close')!.handler({}, toolCtx);
  }, 60000);
});
