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
