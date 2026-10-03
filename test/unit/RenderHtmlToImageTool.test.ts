import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';

// The input, rendering-hardening and cleanup half of the `render_html_to_image`
// suite; output naming, atomicity and delivery live in
// `RenderHtmlOutputDelivery.test.ts`, which is the only half that needs to
// observe the atomic writer.
//
// The tool reaches Playwright only through getPlaywright(), so the whole render
// engine is swappable. vi.mock is hoisted, so the replacement must be built
// inline; the fake it installs lives in the support module.
vi.mock('../../src/tools/browser/BrowserSessionManager', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/tools/browser/BrowserSessionManager')>();
  const { fakePlaywright } = await import('../support/renderHtmlHarness');
  return { ...actual, getPlaywright: () => fakePlaywright() };
});

vi.mock('vscode', () => ({ workspace: { workspaceFolders: undefined } }));

import { makeRenderHtmlToImageTool } from '../../src/tools/renderHtmlToImageTool';
import { STAMP, pngWith, renderFake, resetRenderFake } from '../support/renderHtmlHarness';
import {
  context,
  makeWorkspace,
  removeWorkspace,
  rigDeps,
  setWorkspace,
} from '../support/renderHtmlRig';

let root: string;
function rig(options: Parameters<typeof rigDeps>[0] = {}) {
  const { deps, deliverFile, remainingFileDeliveries } = rigDeps(options);
  return {
    tool: makeRenderHtmlToImageTool(deps),
    deliverFile,
    remainingFileDeliveries,
  };
}

beforeEach(async () => {
  root = await makeWorkspace();
  setWorkspace(root);
  resetRenderFake();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await removeWorkspace(root);
});

describe('render_html_to_image input validation', () => {
  it('refuses both html and path, naming the absence of a fallback', async () => {
    const { tool } = rig();
    await expect(
      tool.handler({ html: '<p>x</p>', path: 'poster.html' }, context()),
    ).rejects.toThrow(/exactly one of html or path, not both/);
  });

  it('refuses when neither is given', async () => {
    const { tool } = rig();
    await expect(tool.handler({}, context())).rejects.toThrow(/one of html or path is required/);
  });

  it('treats whitespace-only html as absent', async () => {
    const { tool } = rig();
    await expect(tool.handler({ html: '   ' }, context())).rejects.toThrow(
      /one of html or path is required/,
    );
  });

  it('refuses html over 10 MB and names the size', async () => {
    const { tool } = rig();
    const html = `<p>${'x'.repeat(10 * 1024 * 1024 + 4)}</p>`;
    const message = await tool.handler({ html }, context()).catch((err: Error) => err.message);
    expect(message).toContain('html is ');
    expect(message).toContain('bytes; the limit is ');
    // The size named is the byte length of the html actually sent, separators
    // included, so compare digits rather than a locale-specific rendering.
    const numbers = (message as string).replace(/[^\d]/g, '');
    expect(numbers).toContain(String(Buffer.byteLength(html, 'utf8')));
    expect(numbers).toContain(String(10 * 1024 * 1024));
  });

  it.each([
    ['width', 0],
    ['width', 8193],
    ['height', -5],
    ['height', 8193],
  ])('refuses %s outside the 1-8192 range', async (name, value) => {
    const { tool } = rig();
    await expect(tool.handler({ html: '<p>x</p>', [name]: value }, context())).rejects.toThrow(
      new RegExp(`${name} is ${value}; the range is 1.8192`),
    );
  });

  it('refuses a non-integer viewport', async () => {
    const { tool } = rig();
    await expect(tool.handler({ html: '<p>x</p>', width: 10.5 }, context())).rejects.toThrow(
      /width must be an integer/,
    );
  });

  it('reads html from a workspace-relative path', async () => {
    await fs.writeFile(path.join(root, 'poster.html'), '<title>Invite</title><h1>OK</h1>');
    const { tool } = rig();
    const result = await tool.handler({ path: 'poster.html' }, context());
    expect(renderFake.setContentCalls[0]).toContain('<h1>OK</h1>');
    expect(result).toContain(`${STAMP}-invite.png`);
  });

  it('refuses a path outside the workspace', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-render-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'poster.html'), '<p>x</p>');
      const { tool } = rig();
      await expect(
        tool.handler({ path: path.join(outside, 'poster.html') }, context()),
      ).rejects.toThrow(/outside the workspace/);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe('render_html_to_image rendering hardening', () => {
  it('launches headless with the exact hardened args and no localhost hole', async () => {
    const { tool } = rig({ config: { browser: { channel: 'msedge' } } });
    await tool.handler({ html: '<p>x</p>' }, context());
    expect(renderFake.launchCalls).toHaveLength(1);
    const launch = renderFake.launchCalls[0]!;
    expect(launch.channel).toBe('msedge');
    expect(launch.headless).toBe(true);
    expect(launch.args).toEqual([
      '--disable-background-networking',
      '--disable-component-update',
      '--no-pings',
      '--host-resolver-rules=MAP * ~NOTFOUND',
    ]);
    // A localhost exclusion would expose Forge's own control server, and a
    // literal quote would become part of the rule (args bypass the shell).
    expect(launch.args.join(' ')).not.toMatch(/localhost|EXCLUDE|["']/);
  });

  it('defaults the channel to chrome when config sets none', async () => {
    const { tool } = rig();
    await tool.handler({ html: '<p>x</p>' }, context());
    expect(renderFake.launchCalls[0]!.channel).toBe('chrome');
  });

  it('disables JavaScript on the context, not the page', async () => {
    const { tool } = rig();
    await tool.handler({ html: '<p>x</p>', width: 800, height: 600 }, context());
    expect(renderFake.contextCalls[0]).toMatchObject({
      javaScriptEnabled: false,
      deviceScaleFactor: 1,
      viewport: { width: 800, height: 600 },
    });
  });

  it('blocks the network on the context, before any content is set', async () => {
    const { tool } = rig();
    await tool.handler({ html: '<p>x</p>' }, context());
    expect(renderFake.routeSelectors).toEqual(['**/*']);
    expect(renderFake.setContentCalls).toHaveLength(1);
  });

  it('uses setContent, never file:// navigation', async () => {
    const { tool } = rig();
    await tool.handler({ html: '<p>x</p>' }, context());
    expect(renderFake.gotoCalls).toBe(0);
    expect(renderFake.setContentCalls[0]).toBe('<p>x</p>');
  });

  it('defaults to a viewport-clipped screenshot and honours full_page', async () => {
    const { tool } = rig();
    await tool.handler({ html: '<p>x</p>' }, context());
    expect(renderFake.screenshotCalls[0]).toEqual({ type: 'png', fullPage: false });
    await tool.handler({ html: '<p>x</p>', full_page: true }, context());
    expect(renderFake.screenshotCalls[1]).toEqual({ type: 'png', fullPage: true });
  });

  it('names the config fix when the browser channel cannot be launched', async () => {
    renderFake.launchError = "Executable doesn't exist";
    const { tool } = rig({ config: { browser: { channel: 'chromium' } } });
    await expect(tool.handler({ html: '<p>x</p>' }, context())).rejects.toThrow(
      /chromium could not be launched/,
    );
    await expect(tool.handler({ html: '<p>x</p>' }, context())).rejects.toThrow(
      /Set browser\.channel to an installed browser \(chrome \| msedge\)\. No silent fallback\./,
    );
  });

  it('refuses a PNG over 10 MB and names its size', async () => {
    renderFake.png = pngWith(1024, 1024, 10 * 1024 * 1024 + 4);
    const { tool } = rig();
    const message = await tool
      .handler({ html: '<p>x</p>' }, context())
      .catch((err: Error) => err.message);
    expect(message).toContain('the PNG is ');
    expect((message as string).replace(/[^\d]/g, '')).toContain(String(10 * 1024 * 1024));
  });

  it('refuses a full_page render past the cap BEFORE Chrome rasterises it', async () => {
    // The point is the ORDER: measuring the document first means a runaway
    // layout never makes Chrome allocate an enormous buffer. Asserting the
    // refusal alone would also pass with the old after-the-fact check.
    renderFake.contentHeight = 20_000;
    renderFake.png = pngWith(1024, 20_000, 100);
    const { tool } = rig();
    await expect(
      tool.handler({ html: '<title>Tall</title>', full_page: true }, context()),
    ).rejects.toThrow(/full_page is capped at 16,?384|capped at/);
    expect(renderFake.evaluateCalls).toBe(1);
    expect(renderFake.screenshotCalls).toHaveLength(0);
  });

  it('does not measure the layout for a viewport-clipped capture', async () => {
    // The cap is for full_page only; a clipped shot can never exceed the
    // viewport, so paying a round trip per render would be pure overhead.
    const { tool } = rig();
    await tool.handler({ html: '<title>Tall</title>', height: 400 }, context());
    expect(renderFake.evaluateCalls).toBe(0);
    expect(renderFake.screenshotCalls).toHaveLength(1);
  });

  it('refuses a full_page render past the 16384 px height cap', async () => {
    renderFake.png = pngWith(1024, 16_385);
    const { tool } = rig();
    await expect(tool.handler({ html: '<p>x</p>', full_page: true }, context())).rejects.toThrow(
      /the page rendered 16385 px tall; the full_page cap is 16384/,
    );
  });

  it('leaves a tall viewport-clipped PNG alone — the cap is for full_page', async () => {
    renderFake.png = pngWith(1024, 16_385);
    const { tool } = rig();
    const result = await tool.handler({ html: '<p>x</p>' }, context());
    expect(result).toContain('at 1024x16385');
  });
});

describe('render_html_to_image cleanup', () => {
  it('closes the browser after a successful render', async () => {
    const { tool } = rig();
    await tool.handler({ html: '<p>x</p>' }, context());
    expect(renderFake.closeCount).toBe(1);
    expect(renderFake.contextCloseCount).toBe(1);
  });

  it('closes the browser when the render fails after launch', async () => {
    renderFake.screenshotError = 'boom';
    const { tool } = rig();
    await expect(tool.handler({ html: '<p>x</p>' }, context())).rejects.toThrow(/boom/);
    expect(renderFake.launchCalls).toHaveLength(1);
    expect(renderFake.closeCount).toBe(1);
  });

  it('leaves no browser when launch itself fails', async () => {
    renderFake.launchError = 'boom';
    const { tool } = rig();
    await expect(tool.handler({ html: '<p>x</p>' }, context())).rejects.toThrow(/boom/);
    expect(renderFake.closeCount).toBe(0); // never launched, so nothing to close
  });

  it('closes a browser that launches AFTER the timeout fires', async () => {
    // The orphan case the plan calls critical: whoever sets the give-up flag
    // had no handle to close, so the late launch continuation must close it.
    // A short REAL deadline is used, not fake timers: the render path does
    // real fs I/O (resolveRealWorkspacePath), which fake timers would deadlock.
    let releaseLaunch!: () => void;
    renderFake.launchGate = () => new Promise<void>((resolve) => (releaseLaunch = resolve));
    const { tool } = rig({ renderTimeoutMs: 50 });

    const pending = tool.handler({ html: '<p>x</p>' }, context());
    await expect(pending).rejects.toThrow(/timed out after 0.05s; the browser was closed/);
    expect(renderFake.closeCount).toBe(0); // nothing was launched yet

    releaseLaunch(); // launch resolves late
    await vi.waitFor(() => expect(renderFake.closeCount).toBe(1));
  });

  it('closes the browser and returns at once when the turn is aborted mid-render', async () => {
    const controller = new AbortController();
    let releaseScreenshot!: () => void;
    renderFake.screenshotGate = () => new Promise<void>((resolve) => (releaseScreenshot = resolve));
    const { tool } = rig();

    const pending = tool.handler({ html: '<p>x</p>' }, context({ abortSignal: controller.signal }));
    await vi.waitFor(() => expect(renderFake.screenshotCalls).toHaveLength(1));
    controller.abort();
    // Prompt: the abort is raced against the render, so the caller is released
    // while the screenshot is still blocked. Waiting for the page to die (the
    // old behaviour) would hang until the gate opened or the deadline fired.
    await expect(pending).rejects.toThrow(/cancelled during rendering/);
    expect(renderFake.closeCount).toBe(1);
    releaseScreenshot();
  });

  it('returns at once when the turn is aborted during a stalled launch', async () => {
    // The defect this pins: an abort during a launch that never returns used to
    // wait out the whole 30 s deadline before the user saw a cancellation.
    const controller = new AbortController();
    let releaseLaunch!: () => void;
    renderFake.launchGate = () => new Promise<void>((resolve) => (releaseLaunch = resolve));
    const { tool } = rig({ renderTimeoutMs: 20_000 });

    const pending = tool.handler({ html: '<p>x</p>' }, context({ abortSignal: controller.signal }));
    await vi.waitFor(() => expect(renderFake.launchCalls).toHaveLength(1));
    const started = Date.now();
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled during rendering/);
    expect(Date.now() - started).toBeLessThan(1_000);

    // The launch that resolves AFTER the abort must still be closed.
    releaseLaunch();
    await vi.waitFor(() => expect(renderFake.closeCount).toBe(1));
  });

  it('does not relabel a mid-render failure that merely contains the word "launch"', async () => {
    // The launch-error branch exists to name the browser.channel fix. Its regex
    // used to include a bare `launch`, so any message containing that word was
    // reported as "chromium could not be launched" and sent the user off to
    // change a setting that was not the problem (review NOTE, 2026-10-03).
    renderFake.screenshotError = 'The page crashed during a renderer relaunch';
    const { tool } = rig({ config: { browser: { channel: 'chromium' } } });
    const message = await tool
      .handler({ html: '<p>x</p>' }, context())
      .catch((err: Error) => err.message);
    expect(message).toContain('The page crashed during a renderer relaunch');
    expect(message).not.toContain('could not be launched');
    expect(message).not.toContain('browser.channel');
  });

  it('refuses a spent file budget BEFORE launching a browser or writing anything', async () => {
    // The budget is owned by UserNotificationService and shared with send_file.
    // Checking it only at deliverFile is not wrong, but it means the 6th call in
    // a turn launches Chrome, rasterises a PNG, writes it and adds an Undo entry
    // before saying no (review NOTE, 2026-10-03). Asserting the absence of all
    // three is the point — a refusal alone would pass either way.
    const { tool, deliverFile, remainingFileDeliveries } = rig({ remaining: 0 });
    const message = await tool
      .handler({ html: '<title>Card</title>' }, context({ conversationId: 'c1' }))
      .catch((err: Error) => err.message);
    expect(message).toContain('per-turn file delivery limit is already spent');
    expect(message).toContain('Nothing was rendered.');
    // Asked about the same conversation the delivery would charge: reading
    // someone else's budget would refuse the wrong turn.
    expect(remainingFileDeliveries!.mock.calls.map((call) => call[0])).toEqual(['c1']);
    expect(renderFake.launchCalls).toHaveLength(0);
    expect(deliverFile).not.toHaveBeenCalled();
    // Nothing at all was created — not even the output directory, which the tool
    // makes only after this check.
    expect(fsSync.existsSync(path.join(root, 'generated-images'))).toBe(false);
  });

  it('renders normally while the budget still has room', async () => {
    // Guards the early refusal against the over-eager fix: `remaining: 1` is
    // enough for this call, and an absent probe (older service shape) must not
    // be read as "spent".
    for (const remaining of [1, 5, undefined]) {
      const { tool } = rig({ remaining });
      const result = await tool.handler({ html: '<title>Card</title>' }, context());
      expect(result).toContain(`Rendered ${STAMP}-card.png`);
      await fs.rm(path.join(root, 'generated-images'), { recursive: true, force: true });
    }
  });

  it('writes and sends nothing when the turn aborts after the screenshot returns', async () => {
    // The window this pins: the screenshot resolved, but the engine still has to
    // close the browser in its finally (an await), so an abort can land after
    // the PNG is in hand and before the tool writes it. Writing then would leave
    // a cancelled turn with an unwanted file and a queued send.
    const controller = new AbortController();
    let releaseClose!: () => void;
    renderFake.closeGate = () => new Promise<void>((resolve) => (releaseClose = resolve));
    const { tool, deliverFile } = rig();

    const pending = tool.handler({ html: '<title>Card</title>' }, context({
      abortSignal: controller.signal,
    }));
    await vi.waitFor(() => expect(renderFake.screenshotCalls).toHaveLength(1));
    controller.abort();
    // Release the close only after the abort has landed: the engine is parked in
    // its finally, so the tool has not resumed yet and the abort is guaranteed
    // to arrive before the write rather than racing it.
    releaseClose();
    // Anchored on the TOOL's own wording, not the engine's "cancelled during
    // rendering": this must be the tool refusing to write, not the render leg
    // failing, or the test would pass even with the pre-write check removed.
    await expect(pending).rejects.toThrow(/nothing was written or sent/);
    expect(deliverFile).not.toHaveBeenCalled();
    // The output directory DOES exist here — it is created before the render so
    // the claim sidecar has somewhere to live — so the claim is that it is empty:
    // no PNG, and no reservation left behind.
    expect(await fs.readdir(path.join(root, 'generated-images'))).toEqual([]);
  });

  it('refuses an already-aborted turn before spawning anything', async () => {
    const controller = new AbortController();
    controller.abort();
    const { tool } = rig();
    await expect(
      tool.handler({ html: '<p>x</p>' }, context({ abortSignal: controller.signal })),
    ).rejects.toThrow(/cancelled before rendering/);
    expect(renderFake.launchCalls).toHaveLength(0);
  });
});
