import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ workspace: { workspaceFolders: undefined } }));

import { foldDrivePath } from '../../src/util/drivePath';
import { resolveWorkspacePath } from '../../src/util/WorkspacePaths';

describe('workspace path containment', () => {
  // Platform-native paths: a hard-coded `C:/` is relative on the Linux and
  // macOS CI runners, so these passed only on Windows.
  const base = path.resolve(os.tmpdir(), 'forge-containment');
  const workspace = path.join(base, 'workspace');

  it('rejects absolute paths outside an active workspace when requested', () => {
    expect(() =>
      resolveWorkspacePath(path.join(base, 'outside', 'secret.txt'), {
        workspaceRoot: workspace,
        mustBeInsideWorkspace: true,
      }),
    ).toThrow(/outside the workspace/i);
  });

  it('says the refusal covers the whole folder, so another spelling is not worth a round', () => {
    const outside = path.join(base, 'outside');
    expect(() =>
      resolveWorkspacePath(path.join(outside, 'scratch.txt'), {
        workspaceRoot: workspace,
        mustBeInsideWorkspace: true,
      }),
    ).toThrow(`Every path under ${outside} is refused the same way`);
  });

  it('allows absolute paths that are inside the active workspace', () => {
    const target = path.join(workspace, 'src', 'index.ts');
    expect(resolveWorkspacePath(target, { workspaceRoot: workspace })).toBe(target);
  });
});

describe('the drive fold (`foldDrivePath`)', () => {
  it('turns the spellings Git Bash and Cygwin produce into the path Windows reads', () => {
    expect(foldDrivePath('/n/Apps/Forge/src/x.ts', 'win32')).toBe('N:/Apps/Forge/src/x.ts');
    expect(foldDrivePath('/cygdrive/n/Apps/Forge/src/x.ts', 'win32')).toBe(
      'N:/Apps/Forge/src/x.ts',
    );
    expect(foldDrivePath('/c/Users/someone/.forge/sessions/a.jsonl', 'win32')).toBe(
      'C:/Users/someone/.forge/sessions/a.jsonl',
    );
  });

  it('leaves the same spelling a folder on any other OS, where it really is one', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      expect(foldDrivePath('/n/Apps/Forge/src/x.ts', platform)).toBe('/n/Apps/Forge/src/x.ts');
      expect(foldDrivePath('/home/x/y', platform)).toBe('/home/x/y');
    }
  });

  it('does not touch a folder that merely begins with a letter', () => {
    expect(foldDrivePath('/tmp/build.out', 'win32')).toBe('/tmp/build.out');
    expect(foldDrivePath('/node_modules/x', 'win32')).toBe('/node_modules/x');
    expect(foldDrivePath('/n', 'win32')).toBe('N:/');
    expect(foldDrivePath('N:/Apps/Forge/x', 'win32')).toBe('N:/Apps/Forge/x');
    expect(foldDrivePath('relative/x.ts', 'win32')).toBe('relative/x.ts');
  });

  it('resolves a Git Bash spelling one way for the sandbox and the secret matcher', () => {
    // The measured defect: one file was a workspace path to `secretPaths.ts`
    // (which had its own copy of these two rules) and "nothing exists there" to
    // the tool that opened it. They now share this function.
    const target = resolveWorkspacePath('/c/forge-fold-test/x.txt', {
      workspaceRoot: 'C:/forge-fold-test',
    });
    if (process.platform === 'win32') {
      expect(target.replace(/\\/gu, '/')).toBe('C:/forge-fold-test/x.txt');
    } else {
      expect(target).toBe('/c/forge-fold-test/x.txt');
    }
  });
});

describe('extra_file_roots', () => {
  const base = path.resolve(os.tmpdir(), 'forge-extra-roots');
  const workspace = path.join(base, 'workspace');
  const extra = path.join(base, 'LocalAppData', 'Forge');

  it('allows a path inside an extra root even though it is outside the workspace', () => {
    const target = path.join(extra, 'staging', 'build.zip');
    expect(
      resolveWorkspacePath(target, {
        workspaceRoot: workspace,
        mustBeInsideWorkspace: true,
        extraRoots: [extra],
      }),
    ).toBe(target);
  });

  it('names the extra roots when a path is outside all of them', () => {
    expect(() =>
      resolveWorkspacePath(path.join(base, 'elsewhere', 'x.txt'), {
        workspaceRoot: workspace,
        mustBeInsideWorkspace: true,
        extraRoots: [extra],
      }),
    ).toThrow(/outside extra_file_roots/);
  });

  it('points at extra_file_roots when none are configured', () => {
    expect(() =>
      resolveWorkspacePath(path.join(extra, 'x.txt'), {
        workspaceRoot: workspace,
        mustBeInsideWorkspace: true,
      }),
    ).toThrow(/add its folder to extra_file_roots/);
  });
});
