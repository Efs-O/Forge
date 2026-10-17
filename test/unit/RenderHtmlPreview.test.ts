import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';

// `render_html_to_image` mode "preview": scripts on, CDN allowlist, nothing
// saved or delivered (RENDER_PREVIEW_PLAN.md). Image mode's suites are
// untouched; this file pins only what preview adds.
vi.mock('../../src/tools/browser/BrowserSessionManager', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/tools/browser/BrowserSessionManager')>();
  const { fakePlaywright } = await import('../support/renderHtmlHarness');
  return { ...actual, getPlaywright: () => fakePlaywright() };
});

vi.mock('vscode', () => ({ workspace: { workspaceFolders: undefined } }));
vi.mock('../../src/tools/renderHtml/previewFetch', () => ({
  guardedFetchResource: vi.fn(async (resourceUrl: string) => {
    if (new URL(resourceUrl).hostname === '127.0.0.1') throw new Error('private address refused');
    return {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/javascript' },
      body: Buffer.from('ok'),
    };
  }),
}));

import { isPreviewRequestAllowed } from '../../src/tools/renderHtml/previewRenderer';
import { PREVIEW_LAUNCH_ARGS } from '../../src/tools/renderHtml/renderBrowser';
import { makeRenderHtmlToImageTool } from '../../src/tools/renderHtmlToImageTool';
import type { MultimodalToolResult } from '../../src/tools/ToolRegistry';
import { pngWith, renderFake, resetRenderFake } from '../support/renderHtmlHarness';
import {
  context,
  makeWorkspace,
  removeWorkspace,
  rigDeps,
  setWorkspace,
} from '../support/renderHtmlRig';

let root: string;
const PAGE = '<html><head><title>Pagoda</title></head><body><canvas></canvas></body></html>';

function rig() {
  const { deps, deliverFile, remainingFileDeliveries } = rigDeps({});
  return { tool: makeRenderHtmlToImageTool(deps), deliverFile, remainingFileDeliveries };
}

async function writePage(name = 'scene.html', html = PAGE): Promise<string> {
  await fs.writeFile(path.join(root, name), html, 'utf8');
  return name;
}

beforeEach(async () => {
  root = await makeWorkspace();
  setWorkspace(root);
  resetRenderFake();
  renderFake.png = pngWith(1024, 1024);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await removeWorkspace(root);
});

describe('render_html_to_image preview: launch hardening', () => {
  it('keeps Chrome DNS blocked, disables WebRTC UDP, and turns scripts on', async () => {
    const { tool } = rig();
    await tool.handler({ mode: 'preview', path: await writePage() }, context());

    expect(renderFake.launchCalls).toHaveLength(1);
    const args = renderFake.launchCalls[0]?.args ?? [];
    expect(args).toEqual([
      '--disable-background-networking',
      '--disable-component-update',
      '--no-pings',
      '--host-resolver-rules=MAP * ~NOTFOUND',
      '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    ]);
    // No hole to Forge's own control server, and no shell quoting in an argv.
    expect(args.join(' ')).not.toMatch(/localhost|127\.0\.0\.1|["']/);
    expect(renderFake.contextCalls[0]).toMatchObject({ javaScriptEnabled: true });
    expect(renderFake.initScripts[0]).toContain('GPUDevice.prototype.createShaderModule');
    expect(renderFake.gotoCalls).toBe(1);
    expect(renderFake.setContentCalls).toEqual([]);
    expect(renderFake.fulfillments[0]).toMatchObject({ body: PAGE });
  });

  it('fetches public HTTP(S) requests through the host guard and refuses local and non-web URLs', async () => {
    renderFake.pageRequests = [
      { url: 'https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.module.js', method: 'GET' },
      { url: 'https://public.example.test/script.js', method: 'GET' },
      { url: 'http://public.example.test/api', method: 'POST' },
      { url: 'https://example.com/?leak=1', method: 'GET' },
      { url: 'http://127.0.0.1:8799/', method: 'GET' },
      { url: 'file:///C:/Windows/win.ini', method: 'GET' },
      { url: 'javascript:alert(1)', method: 'GET' },
    ];
    const { tool } = rig();
    const result = await tool.handler({ mode: 'preview', path: await writePage() }, context());

    expect(renderFake.routeSelectors).toEqual(['**/*']);
    expect(Object.fromEntries(renderFake.routeOutcomes.map((o) => [o.url, o.outcome]))).toEqual({
      'https://forge-preview.invalid/': 'fulfill',
      'https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.module.js': 'fulfill',
      'https://public.example.test/script.js': 'fulfill',
      'http://public.example.test/api': 'fulfill',
      'https://example.com/?leak=1': 'fulfill',
      'http://127.0.0.1:8799/': 'abort',
      'file:///C:/Windows/win.ini': 'abort',
      'javascript:alert(1)': 'abort',
    });
    expect(renderFake.fulfillments).toHaveLength(5);
    expect(String(result)).not.toContain('https://example.com');
    expect(String(result)).toContain('http://127.0.0.1:8799');
    expect(String(result)).toContain('file:');
  });

  it('serves only the page at the synthetic secure origin and lists relative requests as refused', async () => {
    renderFake.pageRequests = [
      { url: 'https://forge-preview.invalid/assets/texture.png', method: 'GET' },
    ];
    const { tool } = rig();
    const result = String(
      await tool.handler({ mode: 'preview', path: await writePage() }, context()),
    );
    expect(renderFake.routeOutcomes).toEqual([
      { url: 'https://forge-preview.invalid/', outcome: 'fulfill' },
      { url: 'https://forge-preview.invalid/assets/texture.png', outcome: 'abort' },
    ]);
    expect(result).toContain(
      'Requests that did not load: https://forge-preview.invalid (refused: preview serves only the page itself)',
    );
  });

  it('allows public web request shapes and uses the unchanged Chrome DNS wall', () => {
    expect(PREVIEW_LAUNCH_ARGS).toContain('--host-resolver-rules=MAP * ~NOTFOUND');
    expect(isPreviewRequestAllowed('not a url', 'GET')).toBe(false);
    expect(isPreviewRequestAllowed('https://public.example.test/script.js', 'GET')).toBe(true);
    expect(isPreviewRequestAllowed('http://public.example.test/api', 'POST')).toBe(true);
    expect(isPreviewRequestAllowed('https://public.example.test/api', 'PUT')).toBe(false);
  });
});

describe('render_html_to_image preview: inputs', () => {
  it('refuses html input and names path as the fix', async () => {
    const { tool } = rig();
    await expect(tool.handler({ mode: 'preview', html: PAGE }, context())).rejects.toThrow(
      /preview mode takes path, not html/,
    );
    expect(renderFake.launchCalls).toHaveLength(0);
  });

  it('refuses a missing path, full_page, an unknown mode, and wait_ms in image mode', async () => {
    const { tool } = rig();
    await expect(tool.handler({ mode: 'preview' }, context())).rejects.toThrow(/requires path/);
    await expect(
      tool.handler({ mode: 'preview', path: await writePage(), full_page: true }, context()),
    ).rejects.toThrow(/full_page applies to image mode only/);
    await expect(tool.handler({ mode: 'video', html: PAGE }, context())).rejects.toThrow(
      /mode must be "image" or "preview"/,
    );
    await expect(tool.handler({ html: PAGE, wait_ms: 500 }, context())).rejects.toThrow(
      /wait_ms apply to mode "preview" only/,
    );
    // The pelican rerun (2026-10-09): frames and keys without mode were dropped
    // silently and a static PNG was saved instead.
    await expect(
      tool.handler(
        { path: await writePage(), frames: [5000], keys: [{ key: 'Enter', hold_ms: 200 }] },
        context(),
      ),
    ).rejects.toThrow(/frames, keys apply to mode "preview" only/);
    expect(renderFake.launchCalls).toHaveLength(0);
  });

  it('returns an explicit no-shaders result without launching a browser', async () => {
    const { tool } = rig();
    const page = await writePage();
    await expect(tool.handler({ mode: 'shader_check', path: page }, context())).resolves.toBe(
      'Shader check: No shaders found.',
    );
    expect(renderFake.launchCalls).toHaveLength(0);
  });

  it('waits 3000 ms by default, honours wait_ms, and bounds it to 0–30000', async () => {
    const { tool } = rig();
    const page = await writePage();
    await tool.handler({ mode: 'preview', path: page }, context());
    await tool.handler({ mode: 'preview', path: page, wait_ms: 0 }, context());
    await tool.handler({ mode: 'preview', path: page, wait_ms: 30_000 }, context());
    await tool.handler({ mode: 'preview', path: page, frames: [30_000] }, context());
    expect(renderFake.waitCalls).toEqual([3_000, 30_000, 30_000]);
    await expect(
      tool.handler({ mode: 'preview', path: page, wait_ms: 30_001 }, context()),
    ).rejects.toThrow(/wait_ms is 30001; the range is 0–30000/);
    await expect(
      tool.handler({ mode: 'preview', path: page, wait_ms: 1.5 }, context()),
    ).rejects.toThrow(/wait_ms must be an integer/);
  });

  it('captures ascending frames and presses bounded keys before the first capture', async () => {
    const { tool } = rig();
    const result = await tool.handler(
      {
        mode: 'preview',
        path: await writePage(),
        frames: [0, 500, 30_000],
        keys: [
          { key: 'KeyW', hold_ms: 100 },
          { key: 'Space', hold_ms: 0 },
        ],
      },
      context({ isVisionModel: true }),
    );
    expect(renderFake.waitCalls).toEqual([500, 29_500]);
    expect(renderFake.keyPresses).toEqual([
      { key: 'w', delay: 100 },
      { key: 'Space', delay: 0 },
    ]);
    expect(
      (result as MultimodalToolResult).content.filter((part) => part.type === 'image_url'),
    ).toHaveLength(3);
    expect((result as MultimodalToolResult).text).toContain('0 ms');
    expect((result as MultimodalToolResult).text).toContain('500 ms');
    expect((result as MultimodalToolResult).text).toContain('30000 ms');
  });

  it('uses frames when wait_ms is also supplied and reports the ignored wait', async () => {
    const { tool } = rig();
    const result = String(
      await tool.handler(
        { mode: 'preview', path: await writePage(), frames: [0, 500], wait_ms: 6000 },
        context(),
      ),
    );
    expect(renderFake.waitCalls).toEqual([500]);
    expect(result).toContain('2 frame(s) captured');
    expect(result).toContain('wait_ms ignored: frames sets the capture times.');
  });

  it('rejects invalid frames and unsupported keys but accepts wait_ms with frames', async () => {
    const { tool } = rig();
    const page = await writePage();
    await expect(
      tool.handler({ mode: 'preview', path: page, frames: [500, 400] }, context()),
    ).rejects.toThrow(/strictly ascending/);
    const both = String(
      await tool.handler({ mode: 'preview', path: page, frames: [1], wait_ms: 2 }, context()),
    );
    expect(both).toContain('wait_ms ignored: frames sets the capture times.');
    await expect(
      tool.handler({ mode: 'preview', path: page, keys: [{ key: 'F12', hold_ms: 0 }] }, context()),
    ).rejects.toThrow(/KeyA–KeyZ/);
    await expect(
      tool.handler({ mode: 'preview', path: page, frames: [30_001] }, context()),
    ).rejects.toThrow(/frames\[0\] is 30001; the range is 0–30000/);
  });
});

describe('render_html_to_image preview: result', () => {
  it('returns errors and capped console output', async () => {
    renderFake.pageErrors = ['ReferenceError: THREE is not defined'];
    renderFake.consoleErrors = Array.from({ length: 11 }, (_, i) => `console failure ${i}`);
    const { tool } = rig();
    const result = String(
      await tool.handler({ mode: 'preview', path: await writePage() }, context()),
    );

    expect(result).toContain('Page errors (12):');
    expect(result).toContain('- ReferenceError: THREE is not defined');
    expect(result).toContain('- console failure 8');
    expect(result).not.toContain('console failure 9');
    expect(result).toContain('2 more error event(s) not shown');
    expect(result).toContain('log: scene ready');
    expect(result).toContain('Console output (1 lines, capped at 4000 characters):');
  });

  it('deduplicates repeated errors while preserving the total event count', async () => {
    renderFake.consoleErrors = [
      ...Array.from({ length: 363 }, () => 'drawIndexed: index out of range'),
      'pipeline layout mismatch',
      'texture format unsupported',
    ];
    const { tool } = rig();
    const result = String(
      await tool.handler({ mode: 'preview', path: await writePage() }, context()),
    );
    expect(result).toContain('Page errors (365):');
    const errorSection = result.split('Console output')[0] ?? '';
    expect(errorSection.match(/^- /gmu)).toHaveLength(3);
    expect(result).toContain('- drawIndexed: index out of range (x363)');
    expect(result).toContain('- pipeline layout mismatch');
    expect(result).toContain('- texture format unsupported');
  });

  it('caps console output at 40 lines and 4000 characters, dropping oldest lines', async () => {
    renderFake.consoleMessages = Array.from({ length: 45 }, (_, i) => ({
      type: 'info' as const,
      text: `line-${i}`,
    }));
    const { tool } = rig();
    const result = String(
      await tool.handler({ mode: 'preview', path: await writePage() }, context()),
    );
    expect(result).toContain('40 lines, capped at 4000 characters');
    expect(result).toContain('5 older console lines dropped');
    expect(result).not.toContain('info: line-0');
    expect(result).toContain('info: line-44');

    renderFake.consoleMessages = [{ type: 'warn', text: 'y'.repeat(4100) }];
    const oversized = String(
      await tool.handler({ mode: 'preview', path: await writePage() }, context()),
    );
    // One oversized line keeps its start, cut to the 4000-character cap.
    expect(oversized).not.toContain('older console lines dropped');
    expect(oversized).toContain(`warn: ${'y'.repeat(100)}`);
    expect(oversized).not.toContain('y'.repeat(4000));
  });

  it('gives a non-vision model text only, saying why there is no image', async () => {
    const { tool } = rig();
    const result = await tool.handler(
      { mode: 'preview', path: await writePage() },
      context({ isVisionModel: false }),
    );
    expect(typeof result).toBe('string');
    expect(result).toContain('Page errors: none.');
    expect(result).toContain('the active model has no vision input');
  });

  it('gives a vision model the text plus exactly one PNG part', async () => {
    const { tool } = rig();
    const result = (await tool.handler(
      { mode: 'preview', path: await writePage() },
      context({ isVisionModel: true }),
    )) as MultimodalToolResult;
    expect(result.text).toContain('Preview of scene.html at 1024x1024');
    expect(result.text).toContain('Frames attached:');
    const images = result.content.filter((part) => part.type === 'image_url');
    expect(images).toHaveLength(1);
    expect(JSON.stringify(images[0])).toContain(
      `data:image/png;base64,${renderFake.png.toString('base64')}`,
    );
  });

  it('closes the browser and context after a preview', async () => {
    const { tool } = rig();
    await tool.handler({ mode: 'preview', path: await writePage() }, context());
    expect(renderFake.closeCount).toBe(1);
    expect(renderFake.contextCloseCount).toBe(1);
  });
});

// The plan's CI-enforced ledger row: preview creates no durable state. A later
// change that starts saving or sending previews fails here.
describe('render_html_to_image preview: no durable state', () => {
  it('makes no beforeMutate call, writes nothing, delivers nothing, and leaves the budget alone', async () => {
    const { tool, deliverFile, remainingFileDeliveries } = rig();
    const beforeMutate = vi.fn();
    const page = await writePage();
    const before = await fs.readdir(root, { recursive: true });

    await tool.handler(
      { mode: 'preview', path: page },
      context({ beforeMutate, isVisionModel: true, conversationId: 'conv-1' }),
    );

    expect(beforeMutate).not.toHaveBeenCalled();
    expect(deliverFile).not.toHaveBeenCalled();
    expect(remainingFileDeliveries).not.toHaveBeenCalled();
    expect(await fs.readdir(root, { recursive: true })).toEqual(before);
  });
});
