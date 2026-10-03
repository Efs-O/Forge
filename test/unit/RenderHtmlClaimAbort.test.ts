import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';

// Codex review regressions (2026-10-03) for the two seams its audit flagged:
// the output-name reservation and the abort listener. Kept separate from
// RenderHtmlToImageTool.test.ts (which covers schema, caps, cleanup and
// delivery) because these two concerns are about what the tool LEAVES BEHIND.

vi.mock('../../src/tools/browser/BrowserSessionManager', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/tools/browser/BrowserSessionManager')>();
  const { fakePlaywright } = await import('../support/renderHtmlHarness');
  return { ...actual, getPlaywright: () => fakePlaywright() };
});

// Controllable failure for the atomic writer: the point is what happens to the
// reservation when the write itself is rejected.
const writeGate = vi.hoisted(() => ({ failWith: undefined as string | undefined }));

vi.mock('../../src/util/atomicWrite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/util/atomicWrite')>();
  return {
    ...actual,
    writeFileAtomicSync: (target: string, content: string | Buffer) => {
      if (writeGate.failWith) throw new Error(writeGate.failWith);
      return actual.writeFileAtomicSync(target, content);
    },
  };
});

vi.mock('vscode', () => ({ workspace: { workspaceFolders: undefined } }));

import { CLAIM_SUFFIX, makeRenderHtmlToImageTool } from '../../src/tools/renderHtmlToImageTool';
import { STAMP, renderFake, resetRenderFake } from '../support/renderHtmlHarness';
import { context, makeWorkspace, removeWorkspace, rigDeps, setWorkspace } from '../support/renderHtmlRig';

let root: string;
const outDir = () => path.join(root, 'generated-images');
const claimPath = (name: string) => `${path.join(outDir(), name)}${CLAIM_SUFFIX}`;

function tool() {
  return makeRenderHtmlToImageTool(rigDeps({}).deps);
}

beforeEach(async () => {
  root = await makeWorkspace();
  setWorkspace(root);
  resetRenderFake();
  writeGate.failWith = undefined;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await removeWorkspace(root);
});

describe('render_html_to_image name reservation', () => {
  it('skips a name another process has reserved, instead of overwriting it', async () => {
    // The claim must be an on-disk exclusive create, not a process-local set:
    // two VS Code windows on one workspace are a real collision partner, and a
    // probe-then-write sequence loses that race silently.
    await fs.mkdir(outDir(), { recursive: true });
    await fs.writeFile(claimPath(`${STAMP}-same.png`), '');

    const result = await tool().handler({ html: '<title>Same</title>' }, context());
    expect(result).toContain(`${STAMP}-same-2.png`);
    // Only the PNG this call actually wrote remains; its own reservation was
    // released, and the other process's is untouched.
    expect(await fs.readdir(outDir())).toEqual([
      `${STAMP}-same-2.png`,
      `${STAMP}-same.png.forge-claim`,
    ]);
  });

  it('leaves no reservation file behind after a successful render', async () => {
    await tool().handler({ html: '<title>Card</title>' }, context());
    expect(await fs.readdir(outDir())).toEqual([`${STAMP}-card.png`]);
  });

  it('gives the base name back when the render fails', async () => {
    renderFake.screenshotError = 'boom';
    await expect(tool().handler({ html: '<title>Card</title>' }, context())).rejects.toThrow(/boom/);
    expect(await fs.readdir(outDir())).toEqual([]);

    renderFake.screenshotError = undefined;
    const result = await tool().handler({ html: '<title>Card</title>' }, context());
    expect(result).toContain(`${STAMP}-card.png`);
    expect(await fs.readdir(outDir())).toEqual([`${STAMP}-card.png`]);
  });

  it('releases the reservation when the turn checkpoint throws', async () => {
    // beforeMutate is caller-supplied and can throw; the claim taken before it
    // must not survive that exit.
    const beforeMutate = () => {
      throw new Error('checkpoint refused');
    };
    await expect(
      tool().handler({ html: '<title>Card</title>' }, context({ beforeMutate })),
    ).rejects.toThrow(/checkpoint refused/);
    expect(await fs.readdir(outDir())).toEqual([]);

    const result = await tool().handler({ html: '<title>Card</title>' }, context());
    expect(result).toContain(`${STAMP}-card.png`);
  });

  it('releases the reservation when the atomic write is rejected', async () => {
    writeGate.failWith = 'disk said no';
    await expect(tool().handler({ html: '<title>Card</title>' }, context())).rejects.toThrow(
      /disk said no/,
    );
    expect(await fs.readdir(outDir())).toEqual([]);

    writeGate.failWith = undefined;
    const result = await tool().handler({ html: '<title>Card</title>' }, context());
    expect(result).toContain(`${STAMP}-card.png`);
  });

  it('does not reclaim a reservation left by a dead host', async () => {
    // Codex review (2026-10-03): reclaiming during acquisition needs a
    // compare-and-delete two processes cannot race, and buys nothing — the name
    // carries the second, so a crashed render only blocks a name that will never
    // be asked for again. So the leftover is left alone and the render steps on.
    await fs.mkdir(outDir(), { recursive: true });
    const stale = claimPath(`${STAMP}-card.png`);
    await fs.writeFile(stale, '');

    const result = await tool().handler({ html: '<title>Card</title>' }, context());
    expect(result).toContain(`${STAMP}-card-2.png`);
    expect(fsSync.existsSync(stale)).toBe(true);
    expect(await fs.readdir(outDir())).toEqual([`${STAMP}-card-2.png`, path.basename(stale)]);
  });

});

describe('render_html_to_image abort listener', () => {
  /**
   * A signal that records every add/remove pair. `removeEventListener` compares
   * function references, so an anonymous wrapper installed at add-time is never
   * detached — the leak Codex flagged, which keeps the render closure (and the
   * browser handle) reachable on a signal that can outlive the tool call.
   */
  function recordingSignal() {
    const added: Array<(event: unknown) => void> = [];
    const removed: Array<(event: unknown) => void> = [];
    const signal = {
      aborted: false,
      addEventListener: (_type: string, listener: (event: unknown) => void) => {
        added.push(listener);
      },
      removeEventListener: (_type: string, listener: (event: unknown) => void) => {
        removed.push(listener);
      },
      fire: () => added.forEach((l) => l({})),
    };
    return { added, removed, signal };
  }

  it('detaches exactly the listener it attached after a successful render', async () => {
    const { added, removed, signal } = recordingSignal();
    await tool().handler({ html: '<p>x</p>' }, context({
      abortSignal: signal as unknown as AbortSignal,
    }));
    expect(added).toHaveLength(1);
    expect(removed).toEqual(added);
  });

  it('detaches the listener after an aborted render too', async () => {
    const { added, removed, signal } = recordingSignal();
    let releaseScreenshot!: () => void;
    renderFake.screenshotGate = () => new Promise<void>((resolve) => (releaseScreenshot = resolve));

    const pending = tool().handler({ html: '<p>x</p>' }, context({
      abortSignal: signal as unknown as AbortSignal,
    }));
    await vi.waitFor(() => expect(renderFake.screenshotCalls).toHaveLength(1));
    signal.fire();
    await expect(pending).rejects.toThrow(/cancelled during rendering/);
    releaseScreenshot();

    expect(added).toHaveLength(1);
    expect(removed).toEqual(added);
    expect(renderFake.closeCount).toBe(1);
  });
});
