import { beforeEach, describe, expect, it, vi } from 'vitest';

// A file may grow after its size check. The mocked handle reports a small size
// and then returns the maximum allowed read plus one byte.
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return {
    ...actual,
    stat: vi.fn(async () => ({ isFile: () => true, size: 1_024 })),
    readFile: vi.fn(async () => 'x'.repeat(11 * 1024 * 1024)),
    open: vi.fn(async () => ({
      stat: vi.fn(async () => ({ isFile: () => true, size: 1_024 })),
      read: vi.fn(async (buffer: Buffer, offset: number, length: number) => {
        buffer.fill(120, offset, offset + length);
        return { bytesRead: length };
      }),
      close: vi.fn(async () => undefined),
    })),
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
import { MAX_HTML_BYTES } from '../../src/tools/renderHtml/htmlInput';
import { runShaderCheck } from '../../src/tools/renderHtml/shaderCheck';
import type { BrowserChannel } from '../../src/tools/browser/BrowserSessionManager';
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

  it('refuses a file that grows and reads no more than the cap plus one byte', async () => {
    const fsMock = await import('fs/promises');
    const tool = makeRenderHtmlToImageTool(deps());

    await expect(
      tool.handler({ path: 'poster.html' }, { beforeMutate: () => undefined }),
    ).rejects.toThrow(/grew to .*bytes while being read/);

    const open = fsMock.open as unknown as {
      mock: { results: Array<{ value: Promise<{ read: ReturnType<typeof vi.fn> }> }> };
    };
    expect(fsMock.open).toHaveBeenCalledTimes(1);
    const handle = await open.mock.results[0]!.value;
    expect(handle.read).toHaveBeenCalledWith(expect.any(Buffer), 0, MAX_HTML_BYTES + 1, null);
    // And it refused before rendering: no browser, no write, no delivery.
    expect((fsMock.mkdir as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(
      0,
    );
  });

  it('uses the same bounded read for shader files', async () => {
    const fsMock = await import('fs/promises');

    await expect(
      runShaderCheck('shader.wgsl', { channel: undefined as unknown as BrowserChannel }),
    ).rejects.toThrow(/shader file grew beyond the 10 MB limit/);

    const open = fsMock.open as unknown as {
      mock: { results: Array<{ value: Promise<{ read: ReturnType<typeof vi.fn> }> }> };
    };
    expect(fsMock.open).toHaveBeenCalledTimes(1);
    const handle = await open.mock.results.at(-1)!.value;
    expect(handle.read).toHaveBeenCalledWith(expect.any(Buffer), 0, MAX_HTML_BYTES + 1, null);
  });
});
