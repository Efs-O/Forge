import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveRealWorkspacePath } from '../../src/util/WorkspacePaths';
import { makeAppendFileTool, makeWriteFileTool } from '../../src/tools/builtinTools';
import {
  makeCreateDirectoryTool,
  makeDeleteFileTool,
  makeMoveFileTool,
} from '../../src/tools/fileEditTools';
import { makeEditFileTool } from '../../src/tools/editFileTool';
import { makeApplyLineEditsTool } from '../../src/tools/structuredEditTool';
import { makeGenerateImageTool } from '../../src/tools/imageGeneration/generateImageTool';
import type { ForgeConfig } from '../../src/config/types';

/**
 * #9 — symlink escape. Every write/move/delete tool used to resolve its target
 * lexically (`resolveWorkspacePath`), which cannot see a symlink or junction
 * inside the workspace that points outside it: `write_file` to `link/evil.txt`
 * (where `link` is a junction to `..`) wrote outside the workspace. Now each
 * tool routes through `resolveRealWorkspacePath`, which real-paths the target
 * (or its nearest existing ancestor) and re-checks containment against the REAL
 * root. This fixture builds exactly that trap and asserts every tool family
 * refuses it.
 *
 * Symlinks/junctions are not available on every filesystem (network shares,
 * some CI runners); where the link cannot be created the suite skips rather
 * than fail on the platform.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-symlink-ws-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-symlink-out-'));
const link = path.join(root, 'link');

let linkSupported = true;
try {
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
} catch {
  linkSupported = false;
}

afterAll(() => {
  // Remove the link before its parent so a recursive rm never follows it into
  // `outside` and deletes the fixture the assertions still read.
  for (const dir of [link, root, outside]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe.runIf(linkSupported)('symlink escape is refused by every write/move/delete tool', () => {
  beforeEach(() => {
    vscode.workspace.workspaceFolders.splice(0, Infinity, { uri: vscode.Uri.file(root) });
  });
  afterEach(() => {
    vscode.workspace.workspaceFolders.splice(0);
  });

  // The shared resolver is the actual security boundary; every tool below is a
  // thin wrapper over it. This pins the behaviour the wrappers depend on.
  it('resolveRealWorkspacePath refuses a missing target whose parent is a link out of the workspace', async () => {
    await expect(
      resolveRealWorkspacePath('link/evil.txt', undefined, { allowMissing: true }),
    ).rejects.toThrow(/outside the workspace/);
  });

  it('resolveRealWorkspacePath refuses an existing file reached through the link', async () => {
    fs.writeFileSync(path.join(outside, 'victim.txt'), 'do not touch', 'utf8');
    await expect(
      resolveRealWorkspacePath('link/victim.txt', undefined, { allowMissing: true }),
    ).rejects.toThrow(/outside the workspace/);
  });

  it('refuses write_file through the link', async () => {
    await expect(
      makeWriteFileTool().handler({ path: 'link/evil.txt', content: 'x' }),
    ).rejects.toThrow(/outside the workspace/);
    expect(fs.existsSync(path.join(outside, 'evil.txt'))).toBe(false);
  });

  it('refuses append_file through the link', async () => {
    await expect(
      makeAppendFileTool().handler({ path: 'link/evil.txt', content: 'x' }),
    ).rejects.toThrow(/outside the workspace/);
    expect(fs.existsSync(path.join(outside, 'evil.txt'))).toBe(false);
  });

  it('refuses create_directory through the link', async () => {
    await expect(makeCreateDirectoryTool().handler({ path: 'link/subdir' })).rejects.toThrow(
      /outside the workspace/,
    );
    expect(fs.existsSync(path.join(outside, 'subdir'))).toBe(false);
  });

  it('refuses move_file to a destination through the link, and keeps the source', async () => {
    fs.writeFileSync(path.join(root, 'real.txt'), 'keep', 'utf8');
    await expect(
      makeMoveFileTool().handler({ source: 'real.txt', destination: 'link/evil.txt' }),
    ).rejects.toThrow(/outside the workspace/);
    expect(fs.existsSync(path.join(outside, 'evil.txt'))).toBe(false);
    // The move was refused before it ran, so the source must survive.
    expect(fs.existsSync(path.join(root, 'real.txt'))).toBe(true);
  });

  it('refuses delete_file through the link and keeps the target', async () => {
    fs.writeFileSync(path.join(outside, 'victim.txt'), 'do not delete', 'utf8');
    await expect(makeDeleteFileTool().handler({ path: 'link/victim.txt' })).rejects.toThrow(
      /outside the workspace/,
    );
    expect(fs.existsSync(path.join(outside, 'victim.txt'))).toBe(true);
  });

  it('refuses edit_file through the link', async () => {
    await expect(
      makeEditFileTool().handler({ filepath: 'link/evil.txt', old_str: 'a', new_str: 'b' }),
    ).rejects.toThrow(/outside the workspace/);
  });

  it('refuses apply_line_edits through the link', async () => {
    await expect(
      makeApplyLineEditsTool().handler({
        path: 'link/evil.txt',
        operations: [
          { start_line: 1, end_line: 1, expected_lines: ['a'], replacement_lines: ['b'] },
        ],
      }),
    ).rejects.toThrow(/outside the workspace/);
  });

  it('refuses generate_image saving through the link', async () => {
    const config = {
      image_generation: {
        backends: [{ name: 'test', provider: 'xai', model: 'm', confirm_each: false }],
        default: 'test',
        output_dir: 'images',
      },
    } as unknown as ForgeConfig;
    const tool = makeGenerateImageTool({
      getConfig: () => config,
      secrets: undefined,
      notifications: { deliverImage: async () => undefined } as never,
      generate: async () => ({ bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mime: 'image/png' }),
      now: () => new Date(),
    });
    await expect(tool.handler({ prompt: 'x', path: 'link/evil' })).rejects.toThrow(
      /outside the workspace/,
    );
    expect(fs.existsSync(path.join(outside, 'evil.png'))).toBe(false);
  });
});
