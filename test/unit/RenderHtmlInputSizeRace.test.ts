import { beforeEach, describe, expect, it, vi } from 'vitest';

// The 10 MB input cap is checked against `stat`, which is a snapshot: a file
// that grows (or is swapped for a bigger symlink target) between `stat` and
// `readFile` would slip past it. Reproducing that race needs control over both
// calls, so `fs/promises` is mocked for THIS suite only — the main suite
// exercises real files and would not be able to make the two disagree.
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return {
    ...actual,
    stat: vi.fn(async () => ({ isFile: () => true, size: 1_024 })),
    readFile: vi.fn(async () => 'x'.repeat(11 * 1024 * 1024)),
    mkdir: vi.fn(async () => undefined),
  };
});

// The output path is resolved through this owner; stub it so the suite tests
// the size guard and not path resolution (covered in the main suite).
vi.mock('../../src/util/WorkspacePaths', () => ({
  resolveRealWorkspacePath: async (p: string) => p,
  isPathInside: () => true,
}));

vi.mock('vscode', () => ({ workspace: { workspaceFolders: undefined } }));

import { makeRenderHtmlToImageTool } from '../../src/tools/renderHtmlToImageTool';
import type { ForgeConfig } from '../../src/config/types';
import {
  FILE_DELIVERY_TURN_LIMIT,
  type UserNotificationService,
} from '../../src/sidebar/UserNotificationService';

function deps() {
  const notifications = {
    deliverFile: async () => ({ kind: 'queued' as const, chats: 1 }),
    remainingFileDeliveries: () => FILE_DELIVERY_TURN_LIMIT,
  } as unknown as UserNotificationService;
  return {
    getConfig: () =>
      ({
        active_model: 'primary',
        llama_server: {},
        models: [{ name: 'primary', gguf_path: '/primary.gguf' }],
      }) as ForgeConfig,
    notifications,
    now: () => new Date('2026-10-03T12:34:56.789Z'),
  };
}

describe('render_html_to_image input size re-check after read', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses a file that grew past the cap between stat and readFile', async () => {
    const fsMock = await import('fs/promises');
    const tool = makeRenderHtmlToImageTool(deps());

    await expect(
      tool.handler({ path: 'poster.html' }, { beforeMutate: () => undefined }),
    ).rejects.toThrow(/grew to .*bytes while being read/);

    // `stat` reported a small file, so the guard that fired is the byte length
    // of what was actually read — not the directory entry.
    expect((fsMock.stat as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(1);
    // And it refused before rendering: no browser, no write, no delivery.
    expect((fsMock.mkdir as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(
      0,
    );
  });
});
