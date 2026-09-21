import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ workspace: { workspaceFolders: undefined } }));

import { resolveWorkspacePath } from '../../src/util/WorkspacePaths';

describe('workspace path containment', () => {
  it('rejects absolute paths outside an active workspace when requested', () => {
    expect(() =>
      resolveWorkspacePath('C:/outside/secret.txt', {
        workspaceRoot: 'C:/workspace',
        mustBeInsideWorkspace: true,
      }),
    ).toThrow(/outside the workspace/i);
  });

  it('allows absolute paths that are inside the active workspace', () => {
    expect(
      resolveWorkspacePath('C:/workspace/src/index.ts', {
        workspaceRoot: 'C:/workspace',
      }),
    ).toBe('C:\\workspace\\src\\index.ts');
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
