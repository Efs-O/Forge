import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { resolveWorkspacePath } from '../../src/util/WorkspacePaths';
import { makeListDirectoryTool } from '../../src/tools/listDirectoryTool';

/**
 * The lab's student typed `list_directory "~/.forge/jobs"` and got
 * `nothing exists there` — a refusal that reads like a fact about the folder,
 * when the real fact is that the tool looked for a directory literally named
 * `~` beside the workspace. The expansion helper already existed for the secret
 * matcher; it was simply never wired into the path the file tools resolve.
 */
const home = (rel: string): string =>
  path
  .join(os.homedir(), rel)
  .replace(/\\/gu, '/')
  .replace(/\/+$/u, '');

const asPosix = (value: string): string => value.replace(/\\/gu, '/');

describe('the home-folder tokens a model spells paths with', () => {
  const root = path.resolve('the-open-workspace');

  it('expands ~ instead of resolving it next to the workspace root', () => {
    expect(asPosix(resolveWorkspacePath('~/.forge/jobs', { workspaceRoot: root }))).toBe(
      home('.forge/jobs'),
    );
  });

  it('expands the cmd and PowerShell spellings of the same folder', () => {
    expect(
      asPosix(resolveWorkspacePath('%USERPROFILE%\\.forge\\jobs', { workspaceRoot: root })),
    ).toBe(home('.forge/jobs'));
    expect(asPosix(resolveWorkspacePath('$HOME/.config/x', { workspaceRoot: root }))).toBe(
      home('.config/x'),
    );
  });

  it('leaves a file whose own name contains ~ alone', () => {
    expect(resolveWorkspacePath('a~b/x.txt', { workspaceRoot: root })).toBe(
      path.join(root, 'a~b', 'x.txt'),
    );
  });

  it('lists the home folder when the caller spells it "~"', async () => {
    // The refusal this fixes came from the tool, not the resolver, so the tool
    // is what gets asserted: `~` alone reaches `readDirectory` as the home path.
    const text = await makeListDirectoryTool().handler({ path: '~' }, undefined);
    expect(text).toMatch(/\[dir\]|\[file\]|\(empty directory\)/u);
  });

  it('leaves a ~ or $HOME that is a directory name of its own alone', () => {
    // Only a LEADING token names the user's folder. `src/~/x` used to become
    // `src/C:/Users/<name>/x` on Windows — a folder nobody typed.
    expect(asPosix(resolveWorkspacePath('src/~/x', { workspaceRoot: root }))).toBe(
      asPosix(path.join(root, 'src', '~', 'x')),
    );
    expect(asPosix(resolveWorkspacePath('./$HOME/x', { workspaceRoot: root }))).toBe(
      asPosix(path.join(root, '$HOME', 'x')),
    );
  });

  it('still refuses a ~ path that escapes every allowed root, quoting what was typed', () => {
    expect(() =>
      resolveWorkspacePath('~/outside/here', {
        workspaceRoot: root,
        mustBeInsideWorkspace: true,
      }),
    ).toThrow(/outside the workspace: ~\/outside\/here/u);
  });
});
