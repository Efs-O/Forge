import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeWriteFileTool } from '../../src/tools/builtinTools';
import { makeReadFileTool } from '../../src/tools/readFileTool';
import { makeListDirectoryTool } from '../../src/tools/listDirectoryTool';
import { makeDeleteFileTool, makeMoveFileTool } from '../../src/tools/fileEditTools';
import { makeEditFileTool } from '../../src/tools/editFileTool';
import { makeApplyLineEditsTool } from '../../src/tools/structuredEditTool';
import { MAX_READ_FILE_CHARS } from '../../src/tools/resultCap';
import { describeDelete } from '../../src/sidebar/deletePreview';
import * as trashRefusal from '../../src/tools/trashRefusal';

function extendedPath(targetPath: string): string {
  if (process.platform !== 'win32' || targetPath.startsWith('\\\\?\\')) return targetPath;
  if (targetPath.startsWith('\\\\')) return `\\\\?\\UNC\\${targetPath.slice(2)}`;
  return `\\\\?\\${targetPath}`;
}

describe('isolated file and directory tool execution', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-file-tools-'));
    vscode.workspace.workspaceFolders.splice(0, Infinity, { uri: vscode.Uri.file(root) });
  });

  afterEach(() => {
    vscode.workspace.workspaceFolders.splice(0);
    fs.rmSync(extendedPath(root), { recursive: true, force: true });
    trashRefusal.clearTrashRefusals();
    vi.restoreAllMocks();
  });

  it('reads ranges and writes files only inside the temporary workspace fixture', async () => {
    await makeWriteFileTool().handler({ path: 'nested/example.txt', content: 'one\ntwo\nthree' });
    expect(fs.readFileSync(path.join(root, 'nested/example.txt'), 'utf8')).toBe('one\ntwo\nthree');
    await expect(
      makeReadFileTool().handler({ path: 'nested/example.txt', start_line: 2, end_line: 3 }),
    ).resolves.toBe('two\nthree');
    await expect(
      makeReadFileTool().handler({ path: 'nested/example.txt', start_line: 4, end_line: 2 }),
    ).resolves.toContain('the file has 3 line(s)');
    await expect(
      makeReadFileTool().handler({ path: 'nested/example.txt', start_line: 4 }),
    ).resolves.toContain('the file has 3 line(s)');
  });

  // Refusing reads outside the workspace bought nothing: list_directory and
  // shell read the same files, and Strata spent ~15 calls getting there.
  it('reads outside the workspace, but still writes only inside it', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-read-outside-'));
    try {
      const target = path.join(outside, 'bench.txt');
      fs.writeFileSync(target, 'outside', 'utf8');
      await expect(makeReadFileTool().handler({ path: target })).resolves.toBe('outside');
      await expect(
        makeWriteFileTool().handler({ path: target, content: 'changed' }),
      ).rejects.toThrow('outside the workspace');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  // read_file was uncapped and decoded anything as UTF-8, so a 1.3 MB PNG
  // became ~1.3 M characters of replacement glyphs and exhausted a one-slot
  // context in a single tool result.
  it('refuses to decode an image and names view_image instead', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    fs.writeFileSync(path.join(root, 'shot.png'), png);
    await expect(makeReadFileTool().handler({ path: 'shot.png' })).rejects.toThrow('view_image');
    // view_image is always advertised; on a model without vision it refuses and says so itself.
    await expect(makeReadFileTool().handler({ path: 'shot.png' })).rejects.toThrow(
      'view_image itself says so if the active model has no vision',
    );
  });

  it('refuses a non-image binary file rather than returning mojibake', async () => {
    fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0x01, 0x00, 0x02, 0x03]));
    await expect(makeReadFileTool().handler({ path: 'blob.bin' })).rejects.toThrow(
      'appears to be a binary file',
    );
  });

  it('caps an oversized text read and says how to get the rest', async () => {
    fs.writeFileSync(path.join(root, 'huge.txt'), 'x'.repeat(MAX_READ_FILE_CHARS + 500), 'utf8');
    const result = (await makeReadFileTool().handler({ path: 'huge.txt' })) as string;
    expect(result.length).toBeLessThan(MAX_READ_FILE_CHARS + 300);
    expect(result).toContain('truncated by read_file');
    expect(result).toContain('start_line');
  });

  // 901 shell commands read files in the 53 sessions since 0.17.80, and `sed -n`
  // was in 639 of them, because one shell round covers several ranges while
  // read_file gave one file per call. Round count, not tokens, is what
  // separated Forge from the harnesses that ship only a shell — so the ranges
  // now come in one call without the shell.
  it('reads several files and ranges in one call, in order, each headed by its path', async () => {
    await makeWriteFileTool().handler({ path: 'a.txt', content: 'one\ntwo\nthree\n' });
    fs.writeFileSync(path.join(root, 'b.txt'), 'alpha\nbeta\ngamma\ndelta\n', 'utf8');
    const out = (await makeReadFileTool().handler({
      reads: [
        { path: 'a.txt', start_line: 1, end_line: 2 },
        { path: 'b.txt' },
        { path: 'b.txt', start_line: 3, end_line: 4 },
      ],
    })) as string;
    expect(out).toContain('--- a.txt (lines 1-2 of 3) ---\none\ntwo');
    expect(out).toContain('--- b.txt (4 lines) ---\nalpha\nbeta\ngamma\ndelta');
    expect(out).toContain('--- b.txt (lines 3-4 of 4) ---\ngamma\ndelta');
    // The order asked for, not the order found on disk, and the same numbering
    // a single read gives, so a `numbered` batch still feeds apply_line_edits.
    expect(out.indexOf('--- a.txt')).toBeLessThan(out.indexOf('--- b.txt (4 lines)'));
    const numbered = (await makeReadFileTool().handler({
      reads: [{ path: 'b.txt', start_line: 2, end_line: 3 }],
      numbered: true,
    })) as string;
    expect(numbered).toContain('2|beta');
    expect(numbered).toContain('3|gamma');
  });

  it('refuses path and reads together, and neither, and names the fix', async () => {
    await makeWriteFileTool().handler({ path: 'a.txt', content: 'one\n' });
    await expect(
      makeReadFileTool().handler({ path: 'a.txt', reads: [{ path: 'b.txt' }] }),
    ).rejects.toThrow('path and reads cannot be used together');
    await expect(makeReadFileTool().handler({})).rejects.toThrow(
      'neither path nor reads was given; minimal valid call: {"path":"src/a.ts"}',
    );
    // A single read still behaves exactly as it did, except the past-the-end range is now the
    // length note instead of an error (prevention pass 2026-11-09); the batching must not change
    // what a lone read says.
    await expect(makeReadFileTool().handler({ path: 'a.txt', start_line: 5 })).resolves.toContain(
      'the file has 1 line(s)',
    );
  });

  // A model that names the same file in both fields means one read, not a
  // contradiction: the mega-bench chat lost a round to this refusal on every one
  // of them. The repeat is now read; everything else still refuses.
  it('reads a path that repeats reads[0].path, and still refuses the rest', async () => {
    await makeWriteFileTool().handler({ path: 'a.txt', content: 'one\n' });
    await makeWriteFileTool().handler({ path: 'b.txt', content: 'alpha\nbeta\n' });

    const ranged = (await makeReadFileTool().handler({
      path: 'a.txt',
      reads: [{ path: 'a.txt', start_line: 1, end_line: 1 }],
    })) as string;
    expect(ranged).toContain('--- a.txt (lines 1-1 of 1) ---');
    expect(ranged).toContain('one');

    const bothFiles = (await makeReadFileTool().handler({
      path: 'a.txt',
      reads: [{ path: 'a.txt' }, { path: 'b.txt' }],
    })) as string;
    expect(bothFiles).toContain('--- a.txt (1 lines) ---');
    expect(bothFiles).toContain('--- b.txt (2 lines) ---');

    // A different second file, an empty batch, and a top-level range — which has
    // nowhere to go inside reads — all keep the refusal.
    await expect(
      makeReadFileTool().handler({ path: 'a.txt', reads: [{ path: 'b.txt' }] }),
    ).rejects.toThrow('path and reads cannot be used together');
    await expect(makeReadFileTool().handler({ path: 'a.txt', reads: [] })).rejects.toThrow(
      'path and reads cannot be used together',
    );
    await expect(
      makeReadFileTool().handler({ path: 'a.txt', start_line: 5, reads: [{ path: 'a.txt' }] }),
    ).rejects.toThrow('path and reads cannot be used together');
  });

  it('a missing path in reads fails only its own section', async () => {
    await makeWriteFileTool().handler({ path: 'a.txt', content: 'one\ntwo\n' });
    const out = (await makeReadFileTool().handler({
      reads: [{ path: 'gone.txt' }, { path: 'a.txt' }],
    })) as string;
    expect(out).toContain('--- gone.txt (read failed) ---');
    expect(out).toContain('nothing exists there');
    // …and the item that could be read still arrives in the same round.
    expect(out).toContain('--- a.txt (2 lines) ---\none\ntwo');
  });

  it('bounds reads so one round cannot swallow the context it saved', async () => {
    await makeWriteFileTool().handler({ path: 'a.txt', content: 'one\n' });
    await expect(
      makeReadFileTool().handler({
        reads: Array.from({ length: 11 }, () => ({ path: 'a.txt' })),
      }),
    ).rejects.toThrow('at most 10 per call');
    await expect(
      makeReadFileTool().handler({ reads: [{ path: 'a.txt' }], start_line: 2 }),
    ).rejects.toThrow('start_line and end_line go with path');
    await expect(
      makeReadFileTool().handler({ reads: [{ path: 'a.txt', mode: 'append' }] }),
    ).rejects.toThrow('unknown mode');
    await expect(makeReadFileTool().handler({ reads: [] })).rejects.toThrow(
      'reads must be a non-empty array',
    );
  });

  it('executes list, replace, structured edit, move, and delete handlers', async () => {
    // `create_directory` was retired on 2026-10-29 (lane B, item B3):
    // `write_file` makes the folders it needs, so this fixture builds its
    // folder by writing into it — which is also the check that parents are
    // still created by the writer, not by a separate tool.
    await makeWriteFileTool().handler({ path: 'work/source.txt', content: 'alpha\nbeta\n' });
    expect(fs.existsSync(path.join(root, 'work'))).toBe(true);

    const listed = (await makeListDirectoryTool().handler({ path: 'work' })) as string;
    expect(listed).toContain('[file] source.txt');
    // Size and age are what let the agent tell a growing file from a stalled
    // one without waiting on a process that prints nothing.
    expect(listed).toMatch(/\[file\] source\.txt \(11 B, \d+s ago\)/u);
    await makeEditFileTool().handler({
      path: 'work/source.txt',
      old_str: 'alpha',
      new_str: 'first',
    });
    await makeApplyLineEditsTool().handler({
      path: 'work/source.txt',
      operations: [
        {
          start_line: 2,
          end_line: 2,
          expected_lines: ['beta'],
          replacement_lines: ['second'],
        },
      ],
    });
    expect(fs.readFileSync(path.join(root, 'work/source.txt'), 'utf8')).toBe('first\nsecond\n');

    await makeMoveFileTool().handler({
      source: 'work/source.txt',
      destination: 'moved/result.txt',
    });
    expect(fs.existsSync(path.join(root, 'moved/result.txt'))).toBe(true);
    await makeDeleteFileTool().handler({ path: 'moved', recursive: true });
    expect(fs.existsSync(path.join(root, 'moved'))).toBe(false);
  });

  it('routes deletions through the recycle bin unless to_trash is false', async () => {
    fs.writeFileSync(path.join(root, 'recycled.txt'), 'bin me', 'utf8');
    trashRefusal.rememberTrashRefusal(path.join(root, 'recycled.txt'), 'old refusal');
    const diagnose = vi.spyOn(trashRefusal, 'diagnoseTrashRefusal');
    vscode.workspace.fs.lastDeleteOptions = undefined;

    const trashed = await makeDeleteFileTool().handler({ path: 'recycled.txt' });
    expect(vscode.workspace.fs.lastDeleteOptions).toEqual({ recursive: false, useTrash: true });
    expect(trashed).toContain('recycle bin');
    expect(fs.existsSync(path.join(root, 'recycled.txt'))).toBe(false);
    expect(diagnose).not.toHaveBeenCalled();
    expect(trashRefusal.trashRefusalForPath(path.join(root, 'recycled.txt'))).toBeUndefined();
    expect(
      await describeDelete({ path: path.join(root, 'recycled.txt'), to_trash: false }),
    ).not.toContain('Recycle bin refused it:');

    fs.writeFileSync(path.join(root, 'gone.txt'), 'forever', 'utf8');
    vscode.workspace.fs.lastDeleteOptions = undefined;
    const purged = await makeDeleteFileTool().handler({ path: 'gone.txt', to_trash: false });
    expect(vscode.workspace.fs.lastDeleteOptions).toBeUndefined();
    expect(purged).toContain('Permanently deleted');
    expect(fs.existsSync(path.join(root, 'gone.txt'))).toBe(false);
  });

  it('does not silently delete permanently when the recycle bin is unavailable', async () => {
    fs.writeFileSync(path.join(root, 'onshare.txt'), 'keep me', 'utf8');
    const diagnose = vi.spyOn(trashRefusal, 'diagnoseTrashRefusal');
    vi.spyOn(vscode.workspace.fs, 'delete').mockRejectedValueOnce(
      new Error('trash is not supported on this filesystem'),
    );

    await expect(makeDeleteFileTool().handler({ path: 'onshare.txt' })).rejects.toThrow(
      /Cause unknown.*file open in another program.*recycle bin's size limit.*to_trash: false/u,
    );
    expect(fs.existsSync(path.join(root, 'onshare.txt'))).toBe(true);
    expect(diagnose).toHaveBeenCalledOnce();
    const diagnosis = trashRefusal.trashRefusalForPath(path.join(root, 'onshare.txt'));
    expect(diagnosis).toContain('Cause unknown');
    expect(diagnosis).not.toMatch(/network shares/iu);
    const preview = await describeDelete({ path: path.join(root, 'onshare.txt'), to_trash: false });
    expect(preview).toContain(`Recycle bin refused it: ${diagnosis}`);
  });

  it('reports overlong descendants when a recycle-bin move is refused', async () => {
    let directory = path.join(root, 'long-folder');
    for (let index = 0; index < 10; index++) {
      directory = path.join(directory, `segment-${'x'.repeat(20)}`);
    }
    fs.mkdirSync(extendedPath(directory), { recursive: true });
    fs.writeFileSync(extendedPath(path.join(directory, 'trajectory.json')), '{}');
    vi.spyOn(vscode.workspace.fs, 'delete').mockRejectedValueOnce(
      new Error('Failed to perform delete operation'),
    );

    await expect(
      makeDeleteFileTool().handler({ path: 'long-folder', recursive: true }),
    ).rejects.toThrow(/Found \d+ paths of 260\+ characters \(longest \d+: .*trajectory\.json\)/u);
  });

  it('rejects stale structured edits without modifying the fixture', async () => {
    const target = path.join(root, 'stale.txt');
    fs.writeFileSync(target, 'current\n', 'utf8');
    await expect(
      makeApplyLineEditsTool().handler({
        path: 'stale.txt',
        operations: [
          {
            start_line: 1,
            end_line: 1,
            expected_lines: ['old'],
            replacement_lines: ['new'],
          },
        ],
      }),
    ).rejects.toThrow('stale');
    expect(fs.readFileSync(target, 'utf8')).toBe('current\n');
  });

  it('refuses a duplicated tips line from every writer, and counts a new one', async () => {
    // The guard matches the workspace root against the path the tool resolved, and
    // that one is real-pathed with `fs/promises`. `os.tmpdir()` on this machine is
    // an 8.3 short path and only that resolver expands it, so the root is real-pathed
    // the same way — `fs.realpathSync` would leave the two spellings apart.
    const realRoot = await fs.promises.realpath(root);
    vscode.workspace.workspaceFolders.splice(0, Infinity, { uri: vscode.Uri.file(realRoot) });
    const tips = path.join(realRoot, 'docs', 'CODING_TIPS.md');
    fs.mkdirSync(path.dirname(tips), { recursive: true });
    fs.writeFileSync(tips, '## EDIT\n1. alpha → one\n', 'utf8');
    const duplicate = '## EDIT\n1. alpha → one\n1. alpha → one\n';

    await expect(
      makeEditFileTool().handler({
        path: 'docs/CODING_TIPS.md',
        edits: [{ old_str: '1. alpha → one', new_str: '1. alpha → one\n1. alpha → one' }],
      }),
    ).rejects.toThrow(/already carries this tip/);
    await expect(
      makeWriteFileTool().handler({ path: 'docs/CODING_TIPS.md', content: duplicate }),
    ).rejects.toThrow(/already carries this tip/);
    await expect(
      makeApplyLineEditsTool().handler({
        path: 'docs/CODING_TIPS.md',
        operations: [
          {
            start_line: 2,
            end_line: 2,
            expected_lines: ['1. alpha → one'],
            replacement_lines: ['1. alpha → one', '1. alpha → one'],
          },
        ],
      }),
    ).rejects.toThrow(/already carries this tip/);
    // Nothing was written by any of the three refusals.
    expect(fs.readFileSync(tips, 'utf8')).toBe('## EDIT\n1. alpha → one\n');

    const written = String(
      await makeEditFileTool().handler({
        path: 'docs/CODING_TIPS.md',
        edits: [{ old_str: '1. alpha → one', new_str: '1. alpha → one\n1. beta → two' }],
      }),
    );
    expect(fs.readFileSync(tips, 'utf8')).toContain('1. beta → two');
    expect(written).toContain('Project tips:');
  });
});
