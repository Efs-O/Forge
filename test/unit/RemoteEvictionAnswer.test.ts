import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteRuntime } from '../../src/remote/RemoteRuntime';
import type { ForgeConfig } from '../../src/config/types';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function runtime(): RemoteRuntime {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-remote-evict-'));
  dirs.push(storage);
  return new RemoteRuntime({
    storageDirectory: storage,
    workspaceId: 'ws',
    host: {} as ForgeHostFacade,
    secrets: { get: vi.fn(), store: vi.fn(), delete: vi.fn(), onDidChange: vi.fn() } as unknown as vscode.SecretStorage,
    notifyLocal: () => undefined,
  });
}

describe('RemoteRuntime.blocksConversationEviction', () => {
  it('fails closed before any config is applied', () => {
    expect(runtime().blocksConversationEviction('c1')).toBeUndefined();
  });

  it('pins nothing once remote is applied as off, though the store never loads', async () => {
    // Remote off never loads the store. Reading that as "unknown" would pin
    // every chat for as long as remote stays off, and `--new` would 409.
    const remote = runtime();
    await remote.applyConfig({} as ForgeConfig);
    expect(remote.blocksConversationEviction('c1')).toBe(false);
    remote.dispose();
  });
});
