import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: {
    showWarningMessage: vi.fn(),
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
  },
}));
vi.mock('../../src/llm/ForgeInstructionsLoader', () => ({
  discoverWorkspaceRepositoryRoots: async () => [],
  ensureForgeInstructionsFile: vi.fn(),
}));

const { bootstrapWorkspace } = await import('../../src/vscode/workspaceBootstrap');
const { SESSION_KEY_V1 } = await import('../../src/sidebar/sessionTypes');

const MARKER = 'forge.migrated.sessions.v2';

function fakeContext(failSessionCopy: boolean) {
  const workspace = new Map<string, unknown>();
  return {
    workspace,
    context: {
      globalState: { get: (key: string) => (key === SESSION_KEY_V1 ? { tabs: [] } : undefined) },
      workspaceState: {
        get: (key: string) => workspace.get(key),
        update: async (key: string, value: unknown) => {
          if (failSessionCopy && key === SESSION_KEY_V1) throw new Error('disk full');
          workspace.set(key, value);
        },
      },
    } as never,
  };
}

describe('bootstrapWorkspace session migration', () => {
  it('copies the global session, then marks the migration done', async () => {
    const { workspace, context } = fakeContext(false);
    await bootstrapWorkspace(context, '');
    expect(workspace.get(SESSION_KEY_V1)).toEqual({ tabs: [] });
    expect(workspace.get(MARKER)).toBe(true);
  });

  // The marker used to be written first, so a failed copy was never retried (U20-02).
  it('leaves the migration retryable when the copy fails', async () => {
    const { workspace, context } = fakeContext(true);
    await expect(bootstrapWorkspace(context, '')).rejects.toThrow('disk full');
    expect(workspace.has(MARKER)).toBe(false);
  });
});
