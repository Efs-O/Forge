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

import {
  PREVIEW_ALLOWED_HOSTS,
  isPreviewRequestAllowed,
} from '../../src/tools/renderHtml/renderEngine';
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
  it('opens DNS for the allowlist only, disables WebRTC UDP, and turns scripts on', async () => {
    const { tool } = rig();
    await tool.handler({ mode: 'preview', path: await writePage() }, context());

    expect(renderFake.launchCalls).toHaveLength(1);
    const args = renderFake.launchCalls[0]?.args ?? [];
    expect(args).toEqual([
      '--disable-background-networking',
      '--disable-component-update',
      '--no-pings',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE cdn.jsdelivr.net, EXCLUDE cdnjs.cloudflare.com, EXCLUDE unpkg.com',
      '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    ]);
    // No hole to Forge's own control server, and no shell quoting in an argv.
    expect(args.join(' ')).not.toMatch(/localhost|127\.0\.0\.1|["']/);
    expect(renderFake.contextCalls[0]).toMatchObject({ javaScriptEnabled: true });
    expect(renderFake.gotoCalls).toBe(0);
    expect(renderFake.setContentCalls).toEqual([PAGE]);
  });

  it('routes only https GETs to the three CDNs through', async () => {
    renderFake.pageRequests = [
      { url: 'https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.module.js', method: 'GET' },
      { url: 'https://unpkg.com/three/examples/jsm/controls/OrbitControls.js', method: 'GET' },
      { url: 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js', method: 'GET' },
      { url: 'https://cdn.jsdelivr.net/npm/x', method: 'POST' },
      { url: 'http://cdn.jsdelivr.net/npm/three', method: 'GET' },
      { url: 'https://example.com/?leak=1', method: 'GET' },
      { url: 'http://127.0.0.1:8799/', method: 'GET' },
      { url: 'file:///C:/Windows/win.ini', method: 'GET' },
      { url: 'https://cdn.jsdelivr.net.evil.example/x', method: 'GET' },
    ];
    const { tool } = rig();
    const result = await tool.handler({ mode: 'preview', path: await writePage() }, context());

    expect(renderFake.routeSelectors).toEqual(['**/*']);
    expect(renderFake.routeOutcomes.map((o) => o.outcome)).toEqual([
      'continue',
      'continue',
      'continue',
      'abort',
      'abort',
      'abort',
      'abort',
      'abort',
      'abort',
    ]);
    expect(String(result)).toContain('https://example.com');
    expect(String(result)).toContain('http://127.0.0.1:8799');
    expect(String(result)).toContain('file:');
  });

  it('keeps the allowlist to exactly the three script CDNs', () => {
    expect([...PREVIEW_ALLOWED_HOSTS]).toEqual([
      'cdn.jsdelivr.net',
      'cdnjs.cloudflare.com',
      'unpkg.com',
    ]);
    expect(isPreviewRequestAllowed('not a url', 'GET')).toBe(false);
    expect(isPreviewRequestAllowed('https://CDN.JSDELIVR.NET/npm/x', 'GET')).toBe(true);
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
      /wait_ms applies to mode "preview" only/,
    );
    expect(renderFake.launchCalls).toHaveLength(0);
  });

  it('waits 3000 ms by default, honours wait_ms, and bounds it to 0–15000', async () => {
    const { tool } = rig();
    const page = await writePage();
    await tool.handler({ mode: 'preview', path: page }, context());
    await tool.handler({ mode: 'preview', path: page, wait_ms: 0 }, context());
    await tool.handler({ mode: 'preview', path: page, wait_ms: 15_000 }, context());
    expect(renderFake.waitCalls).toEqual([3_000, 15_000]);
    await expect(
      tool.handler({ mode: 'preview', path: page, wait_ms: 15_001 }, context()),
    ).rejects.toThrow(/wait_ms is 15001; the range is 0–15000/);
    await expect(
      tool.handler({ mode: 'preview', path: page, wait_ms: 1.5 }, context()),
    ).rejects.toThrow(/wait_ms must be an integer/);
  });
});

describe('render_html_to_image preview: result', () => {
  it('returns page and console errors, not console logs, capped at 10', async () => {
    renderFake.pageErrors = ['ReferenceError: THREE is not defined'];
    renderFake.consoleErrors = Array.from({ length: 11 }, (_, i) => `console failure ${i}`);
    const { tool } = rig();
    const result = String(await tool.handler({ mode: 'preview', path: await writePage() }, context()));

    expect(result).toContain('Page errors (12):');
    expect(result).toContain('- ReferenceError: THREE is not defined');
    expect(result).toContain('- console failure 8');
    expect(result).not.toContain('console failure 9');
    expect(result).toContain('2 more not shown');
    expect(result).not.toContain('scene ready');
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
    expect(result.text).toContain('Screenshot attached.');
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
