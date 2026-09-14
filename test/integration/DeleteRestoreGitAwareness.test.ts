/**
 * The delete/restore gap, reproduced end to end.
 *
 * A session hashed `CHANGES.md` and its generated twin `CHANGELOG.md`, found
 * them byte-identical, deleted the tracked one as a duplicate, committed the
 * deletion, and then could not put it back: `git checkout HEAD~1 -- CHANGES.md`
 * is denylisted and the refusal named two tools that cannot restore a file.
 * These tests pin each half of the fix.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import {
  describeDeletedTrackedFile,
  describeGitLineForDelete,
  describeTrackedState,
} from '../../src/tools/gitTrackedStatus';
import { makeCommitTool, makeRestoreFileTool, makeStageTool } from '../../src/tools/gitTools';
import { makeDeleteFileTool } from '../../src/tools/fileEditTools';

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@e',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@e',
};

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, env, encoding: 'utf8' });
}

/** git checks out through core.autocrlf, so content compares line-ending-blind. */
function readNormalized(file: string): string {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/gu, '\n');
}

describe('git awareness around delete and restore', () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-del-')));
    git(root, ['init', '-b', 'main']);
    // The env above only reaches this file's own git calls; the commit tool
    // spawns git with the real environment, which has no identity on CI.
    git(root, ['config', 'user.name', 'Forge Test']);
    git(root, ['config', 'user.email', 'forge@test.invalid']);
    fs.writeFileSync(path.join(root, 'CHANGES.md'), '# 1.0\n', 'utf8');
    fs.writeFileSync(path.join(root, '.gitignore'), '/CHANGELOG.md\n', 'utf8');
    git(root, ['add', 'CHANGES.md', '.gitignore']);
    git(root, ['commit', '-m', 'seed']);
    // The generated twin: identical bytes, deliberately not tracked.
    fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# 1.0\n', 'utf8');
    fs.writeFileSync(path.join(root, 'scratch.txt'), 'untracked\n', 'utf8');
    vscode.workspace.workspaceFolders.splice(0, Infinity, { uri: vscode.Uri.file(root) });
    vi.spyOn(vscode.extensions, 'getExtension').mockReturnValue(undefined as never);
  });

  afterEach(() => {
    vscode.workspace.workspaceFolders.splice(0);
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('tells the two byte-identical files apart by tracking, not content', async () => {
    expect(await describeTrackedState('CHANGES.md')).toBe('tracked');
    expect(await describeTrackedState('CHANGELOG.md')).toBe('ignored');
    expect(await describeTrackedState('scratch.txt')).toBe('untracked');
  });

  it('reports not-a-repo instead of throwing outside a repository', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-norepo-'));
    try {
      expect(await describeTrackedState(path.join(outside, 'x.txt'))).toBe('not-a-repo');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('warns in the delete result when the deleted path was tracked', async () => {
    const result = String(
      await makeDeleteFileTool().handler(
        { path: 'CHANGES.md', to_trash: false },
        undefined as never,
      ),
    );
    expect(result).toContain('Permanently deleted: CHANGES.md');
    expect(result).toContain('tracked in git at HEAD');
    expect(result).toContain('restore_file');
  });

  it('stays silent for a generated file, so the warning keeps its meaning', async () => {
    const result = String(
      await makeDeleteFileTool().handler(
        { path: 'CHANGELOG.md', to_trash: false },
        undefined as never,
      ),
    );
    expect(result).toBe('Permanently deleted: CHANGELOG.md');
  });

  it('names the tracking state in the approval dialog line', async () => {
    expect(await describeGitLineForDelete('CHANGES.md')).toContain('tracked');
    expect(await describeGitLineForDelete('CHANGELOG.md')).toContain('ignored');
  });

  it('says nothing for states that carry no warning', () => {
    expect(describeDeletedTrackedFile('ignored', 'CHANGELOG.md')).toBe('');
    expect(describeDeletedTrackedFile('not-a-repo', 'x')).toBe('');
  });

  it('stage names the kind of change, so a deletion cannot read as an edit', async () => {
    fs.rmSync(path.join(root, 'CHANGES.md'));
    const result = String(
      await makeStageTool().handler({ paths: ['CHANGES.md'] }, undefined as never),
    );
    expect(result).toBe('Staged: CHANGES.md (deleted)');
  });

  it('restores a file a previous commit deleted', async () => {
    fs.rmSync(path.join(root, 'CHANGES.md'));
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', 'remove duplicate CHANGES.md']);
    expect(fs.existsSync(path.join(root, 'CHANGES.md'))).toBe(false);

    const result = String(
      await makeRestoreFileTool().handler(
        { paths: ['CHANGES.md'], ref: 'HEAD~1' },
        undefined as never,
      ),
    );
    expect(result).toContain('Restored from HEAD~1');
    expect(readNormalized(path.join(root, 'CHANGES.md'))).toBe('# 1.0\n');
  });

  it('restores an edited file from HEAD by default', async () => {
    fs.writeFileSync(path.join(root, 'CHANGES.md'), 'clobbered\n', 'utf8');
    await makeRestoreFileTool().handler({ paths: ['CHANGES.md'] }, undefined as never);
    expect(readNormalized(path.join(root, 'CHANGES.md'))).toBe('# 1.0\n');
  });

  it('rejects a ref that would reach git as an option', async () => {
    await expect(
      makeRestoreFileTool().handler({ paths: ['CHANGES.md'], ref: '--hard' }, undefined as never),
    ).rejects.toThrow(/looks like an option/u);
  });

  it('amends the previous commit', async () => {
    fs.writeFileSync(path.join(root, 'CHANGES.md'), '# 1.1\n', 'utf8');
    git(root, ['add', 'CHANGES.md']);
    git(root, ['commit', '-m', 'typo in message']);
    const before = git(root, ['rev-list', '--count', 'HEAD']).trim();

    const result = String(
      await makeCommitTool().handler(
        { message: 'Bump to 1.1', amend: true, cwd: root },
        undefined as never,
      ),
    );
    expect(result).toBe('Amended: Bump to 1.1');
    expect(git(root, ['log', '-1', '--format=%s']).trim()).toBe('Bump to 1.1');
    // An amend replaces; it must not add.
    expect(git(root, ['rev-list', '--count', 'HEAD']).trim()).toBe(before);
  });

  it('amends with an empty index, since a message-only amend is legitimate', async () => {
    const result = String(
      await makeCommitTool().handler(
        { message: 'seed, reworded', amend: true, cwd: root },
        undefined as never,
      ),
    );
    expect(result).toBe('Amended: seed, reworded');
  });

  it('refuses to amend a commit that has reached a remote', async () => {
    const remote = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-remote-')));
    try {
      git(remote, ['init', '--bare', '-b', 'main']);
      git(root, ['remote', 'add', 'origin', remote]);
      git(root, ['push', '-u', 'origin', 'main']);
      await expect(
        makeCommitTool().handler(
          { message: 'rewrite history', amend: true, cwd: root },
          undefined as never,
        ),
      ).rejects.toThrow(/refusing to amend/u);
    } finally {
      fs.rmSync(remote, { recursive: true, force: true });
    }
  });

  it('still refuses a non-amend commit with nothing staged', async () => {
    await expect(
      makeCommitTool().handler({ message: 'empty', cwd: root }, undefined as never),
    ).rejects.toThrow(/nothing is staged/u);
  });
});
