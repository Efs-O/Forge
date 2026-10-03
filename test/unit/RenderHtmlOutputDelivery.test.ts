import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';

// The output/delivery half of the `render_html_to_image` suite; the input,
// rendering-hardening and cleanup halves stay in `RenderHtmlToImageTool.test.ts`.
// The split is a real seam: this file is the only one that needs to observe the
// atomic writer, and it never asserts on the render call sequence.

// The tool reaches Playwright only through getPlaywright(), so the whole render
// engine is swappable. vi.mock is hoisted, so the replacement must be built
// inline; the fake it installs lives in the support module.
vi.mock('../../src/tools/browser/BrowserSessionManager', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/tools/browser/BrowserSessionManager')>();
  const { fakePlaywright } = await import('../support/renderHtmlHarness');
  return { ...actual, getPlaywright: () => fakePlaywright() };
});

// Records the write order and whether the final name existed mid-write, without
// replacing the real atomic writer (which has its own suite).
const atomic = vi.hoisted(() => ({
  calls: [] as Array<{ target: string; existedDuring: boolean }>,
  order: [] as string[],
}));

vi.mock('../../src/util/atomicWrite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/util/atomicWrite')>();
  return {
    ...actual,
    writeFileAtomicSync: (
      target: string,
      content: string | Buffer,
      expected?: { size: number; mtimeMs: number; ctimeMs: number },
    ) => {
      atomic.calls.push({ target, existedDuring: fsSync.existsSync(target) });
      atomic.order.push('write');
      return actual.writeFileAtomicSync(target, content, ...(expected ? [expected] : []));
    },
  };
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
  const { deps, deliverFile } = rigDeps(options);
  return { tool: makeRenderHtmlToImageTool(deps), deliverFile };
}

beforeEach(async () => {
  root = await makeWorkspace();
  setWorkspace(root);
  resetRenderFake();
  atomic.calls = [];
  atomic.order = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  await removeWorkspace(root);
});

describe('render_html_to_image output and delivery', () => {
  it('checkpoints the output path before the write', async () => {
    const order: string[] = [];
    const beforeMutate = vi.fn(() => order.push('beforeMutate'));
    const { tool } = rig();

    const result = await tool.handler(
      { html: '<title>Birthday Invite</title>' },
      context({ beforeMutate }),
    );

    expect(order).toEqual(['beforeMutate']);
    expect(atomic.order).toEqual(['write']);
    // The checkpoint names the file about to be written, so Undo removes
    // exactly it. Compared on the real path: resolveRealWorkspacePath returns
    // the realpath form, which on Windows is not always the mkdtemp spelling.
    const checkpointed = (beforeMutate.mock.calls[0]![0] as string[])[0]!;
    expect(path.basename(checkpointed)).toBe(`${STAMP}-birthday-invite.png`);
    expect(fsSync.realpathSync.native(checkpointed)).toBe(
      fsSync.realpathSync.native(
        path.join(root, 'generated-images', `${STAMP}-birthday-invite.png`),
      ),
    );
    expect(result).toContain(`${STAMP}-birthday-invite.png`);
  });

  it('writes through the atomic owner, never exposing a partial .png', async () => {
    const { tool } = rig();
    await tool.handler({ html: '<title>Card</title>' }, context());
    expect(atomic.calls).toHaveLength(1);
    // The final name must not exist while the bytes are being written: a torn
    // PNG reaching deliverFile (which reads the path later) is the defect. The
    // name is reserved by a SEPARATE sidecar file, not by the `.png`, so this
    // stays true — and Undo still deletes the file rather than restoring a
    // 0-byte placeholder.
    expect(atomic.calls[0]!.existedDuring).toBe(false);
    expect(path.basename(atomic.calls[0]!.target)).toBe(`${STAMP}-card.png`);
  });

  it('leaves no temp file behind and writes the exact bytes', async () => {
    const bytes = pngWith(640, 480, 100);
    renderFake.png = bytes;
    const { tool } = rig();
    await tool.handler({ html: '<title>Card</title>' }, context());

    const entries = await fs.readdir(path.join(root, 'generated-images'));
    expect(entries).toEqual([`${STAMP}-card.png`]);
    const written = await fs.readFile(path.join(root, 'generated-images', entries[0]!));
    expect(written.equals(bytes)).toBe(true);
  });

  it('uses image_generation.output_dir when configured', async () => {
    const { tool } = rig({ config: { image_generation: { output_dir: 'art/posters' } } });
    await tool.handler({ html: '<title>Card</title>' }, context());
    expect(await fs.readdir(path.join(root, 'art', 'posters'))).toEqual([`${STAMP}-card.png`]);
  });
  it('names the file from the <title> slug, falling back to "render"', async () => {
    // Plan row: slug from <title> (trimmed, lowercased, non-alphanumeric -> `-`,
    // max 40 chars), or `render` when there is no <title>.
    const cases: Array<[string, string]> = [
      ['<title>Birthday  Bash!! 🎉</title>', 'birthday-bash'],
      ['<title>  MIXED Case Title  </title>', 'mixed-case-title'],
      ['<title>' + 'a'.repeat(60) + '</title>', 'a'.repeat(40)],
      ['<p>no title at all</p>', 'render'],
      ['<title>!!! ??? ???</title>', 'render'],
    ];
    for (const [html, slug] of cases) {
      const { tool } = rig();
      await tool.handler({ html }, context());
      const entries = await fs.readdir(path.join(root, 'generated-images'));
      expect(entries).toEqual([`${STAMP}-${slug}.png`]);
      await fs.rm(path.join(root, 'generated-images'), { recursive: true, force: true });
    }
  });

  it('renders with the documented fallbacks when no config getter is supplied', async () => {
    // registerAllTools registers this tool unconditionally, so it can be built
    // with `getConfig` undefined. A required-config read would be a runtime
    // crash for every such call site; the fallbacks are DEFAULT_OUTPUT_DIR and
    // the 'chrome' channel.
    const { tool } = rig({ noConfigGetter: true });
    const result = await tool.handler({ html: '<title>Card</title>' }, context());
    expect(result).toContain(`Rendered ${STAMP}-card.png`);
    expect(await fs.readdir(path.join(root, 'generated-images'))).toEqual([`${STAMP}-card.png`]);
  });

  it('gives a same-title second render its own name, so a queued upload is not replaced', async () => {
    // The defect this pins (Codex MUST-FIX): the stamp has 1-second granularity
    // and the slug comes from <title>, so two renders of the same title in one
    // second used to land on the SAME path. `deliverFile` hands the path to a
    // queued task that reads the bytes later, so the second write replaced what
    // the FIRST delivery was about to upload — both chats got the second image.
    const first = pngWith(640, 480, 10);
    const second = pngWith(640, 480, 999);
    const { tool, deliverFile } = rig();

    renderFake.png = first;
    const r1 = await tool.handler({ html: '<title>Same</title>' }, context());
    renderFake.png = second;
    const r2 = await tool.handler({ html: '<title>Same</title>' }, context());

    // Read each delivered path AFTER both renders, which is when the real queue
    // reads them — the whole point of the claim.
    const paths = deliverFile.mock.calls.map(
      (call) => (call[0] as { imagePath: string }).imagePath,
    );
    expect(paths).toHaveLength(2);
    expect(paths[0]).not.toBe(paths[1]);
    expect(path.basename(paths[0]!)).toBe(`${STAMP}-same.png`);
    expect(path.basename(paths[1]!)).toBe(`${STAMP}-same-2.png`);
    expect(fsSync.readFileSync(paths[0]!).equals(first)).toBe(true);
    expect(fsSync.readFileSync(paths[1]!).equals(second)).toBe(true);
    expect(r1).toContain(`${STAMP}-same.png`);
    expect(r2).toContain(`${STAMP}-same-2.png`);
  });

  it('delivers through the budgeted deliverFile with a render_html caption', async () => {
    const { tool, deliverFile } = rig();
    await tool.handler({ html: '<title>Card</title>' }, context({ conversationId: 'c1' }));
    const delivered = deliverFile.mock.calls[0]![0] as {
      conversationId: string;
      text: string;
      imagePath: string;
    };
    expect(delivered.conversationId).toBe('c1');
    expect(delivered.text).toBe(`🖼 render_html: ${STAMP}-card.png`);
    expect(path.basename(delivered.imagePath)).toBe(`${STAMP}-card.png`);
    expect(fsSync.existsSync(delivered.imagePath)).toBe(true);
  });

  it('reports Queued with the size and dimensions, never Sent', async () => {
    const bytes = pngWith(1024, 768, 1_000);
    renderFake.png = bytes;
    const { tool } = rig();
    const result = await tool.handler({ html: '<title>Card</title>' }, context());
    expect(result).toContain(`Rendered ${STAMP}-card.png (PNG, `);
    expect(result).toContain(' bytes) at 1024x768. Queued for 1 remote chat(s).');
    expect(result.replace(/[^\d]/g, '')).toContain(String(bytes.length));
    expect(result).not.toContain('Sent to');
  });

  it('says no chat is watching when the delivery reaches nobody', async () => {
    const { tool } = rig({ deliver: async () => ({ kind: 'queued' as const, chats: 0 }) });
    const result = await tool.handler({ html: '<title>Card</title>' }, context());
    expect(result).toContain('No remote chat is watching this turn.');
  });

  it('keeps the PNG and names the refusal when the shared budget is spent', async () => {
    const reason = 'File delivery limit reached: 5 of 5 allowed this turn.';
    const { tool } = rig({
      deliver: async () => ({ kind: 'refused' as const, spentThisTurn: 5, reason }),
    });
    const result = await tool.handler({ html: '<title>Card</title>' }, context());
    expect(result).toContain(`Rendered ${STAMP}-card.png`);
    expect(result).toContain('File delivery limit reached: 5 of 5');
    expect(await fs.readdir(path.join(root, 'generated-images'))).toEqual([`${STAMP}-card.png`]);
  });
});
