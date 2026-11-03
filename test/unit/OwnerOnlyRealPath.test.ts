import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ownerOnlySetFor, ownerOnlyWriteTargetFor } from '../../src/tools/ownerPaths';
import { classifyShellCommand } from '../../src/tools/shellPolicy';

/**
 * The owner-only guard asked of the file system, not only the text. The
 * 2026-11-02 red-team changed `~/.forge/policy.yaml` by spelling the home folder
 * with its 8.3 short name; a junction into `~/.forge` is the same hole by another
 * route. These fixtures are real folders, because the question is what the disk
 * says a path is.
 */
let base: string;
let home: string;
let workspace: string;

beforeEach(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'owner-real-')));
  home = path.join(base, 'home folder');
  workspace = path.join(base, 'ws');
  fs.mkdirSync(path.join(home, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(home, '.forge', 'policy.yaml'), 'permissions: {}\n');
  fs.mkdirSync(workspace);
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const setFor = () => ownerOnlySetFor({ home, workspaceRoot: workspace });

describe('a write judged by what the disk says the path is', () => {
  it.skipIf(process.platform !== 'win32')('refuses a write through a junction into ~/.forge', () => {
    const link = path.join(workspace, 'link');
    fs.symlinkSync(path.join(home, '.forge'), link, 'junction');
    expect(ownerOnlyWriteTargetFor('link/policy.yaml', setFor(), workspace)).toBeDefined();
    const set = setFor();
    const check = { ownerOnly: set.roots, home, platform: 'win32' as const, cwd: workspace };
    expect(
      classifyShellCommand("echo x >> link/policy.yaml", 'bash', check).classification,
    ).toBe('refused');
  });

  it('refuses a write that names ~/.forge by its 8.3 short name', () => {
    // os.tmpdir() is a short-name path on a Windows profile whose name has a
    // space (`C:/Users/EFSOOF~1/...`); elsewhere there is no short form to test.
    const short = os.tmpdir();
    const long = fs.realpathSync.native(short);
    if (process.platform !== 'win32' || short.toLowerCase() === long.toLowerCase()) return;
    const shortTarget = path.join(short, path.relative(long, home), '.forge', 'policy.yaml');
    expect(shortTarget.toLowerCase()).not.toContain(home.toLowerCase());
    expect(ownerOnlyWriteTargetFor(shortTarget, setFor(), workspace)).toBeDefined();
  });

  it('still lets an ordinary workspace write through', () => {
    expect(ownerOnlyWriteTargetFor('notes.txt', setFor(), workspace)).toBeUndefined();
    const link = path.join(workspace, 'sub');
    fs.mkdirSync(link);
    expect(ownerOnlyWriteTargetFor('sub/policy.yaml', setFor(), workspace)).toBeUndefined();
  });
});
