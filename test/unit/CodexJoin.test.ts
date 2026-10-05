import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { joinCodex } from '../../src/agentMesh/codexJoin';
import { getAlias } from '../../src/agentMesh/aliasRegistry';
import { codexQueueAdapter } from '../../src/agentMesh/codexPinLiveness';
import { MeshSessionProvider } from '../../src/agentMesh/sessionProvider';
import type { ForgeConfig } from '../../src/config/types';

let root: string;

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-codex-join-'));
});

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('interactive Codex join', () => {
  it('registers a user-owned alias that resolves through codex queue', async () => {
    expect(joinCodex(root, 'codex', 'thread-7').ok).toBe(true);
    expect(getAlias(root, 'codex')).toMatchObject({
      agent: 'codex',
      session_id: 'thread-7',
      by: 'user',
    });
    const queueCodex = vi.fn(async () => undefined);
    const adapter = codexQueueAdapter({
      ownedCodex: undefined,
      busRoot: root,
      workspace: '/ws',
      getConfig: () => ({ agent_bus: { codex_cli: 'codex' } }) as ForgeConfig,
      queueCodex,
    });
    expect(adapter?.observesTurns).toBe(false);
    expect(adapter?.deliveredTo).toBe('codex = session thread-7 (queued)');
    await adapter?.send('wake supervisor');
    expect(queueCodex).toHaveBeenCalledWith('codex', 'thread-7', 'wake supervisor', undefined);
  });

  it('provider reaches a joined thread with a live window through the queue adapter', async () => {
    expect(joinCodex(root, 'codex', 'thread-7').ok).toBe(true);
    const queueCodex = vi.fn(async () => undefined);
    let disposed = false;
    // A joined thread is now reached through the stand-in, which tries to resume
    // it. A live window holds the thread, so the resume hits the writer conflict
    // and the stand-in falls back to the non-observing queue adapter (CODEX
    // _STAND_IN_PLAN Phase 3) — the factory IS called, unlike the old direct path.
    const createOwned = vi.fn(
      async () =>
        ({
          ensureStarted: async () => {
            throw new Error('thread thread-7 already has an active writer');
          },
          send: async () => ({ status: 'completed', finalText: 'x' }),
          interrupt: () => {},
          dispose: async () => {
            disposed = true;
          },
        }) as never,
    );
    const provider = new MeshSessionProvider({
      busRoot: root,
      getConfig: () => ({ agent_bus: { enabled: true, codex_cli: 'codex' } }) as ForgeConfig,
      workspaceRoots: () => ['/ws'],
      queueCodex,
      codexFactory: { create: createOwned },
      processStartMs: () => 1_700_000_000_000,
    });

    const adapter = await provider.resolveAdapter('codex');
    expect(createOwned).toHaveBeenCalled();
    expect(disposed).toBe(true);
    expect(adapter?.observesTurns).toBe(false);
    await adapter?.send('one-way progress note');
    expect(queueCodex).toHaveBeenCalledWith(
      'codex',
      'thread-7',
      'one-way progress note',
      undefined,
    );
    await provider.dispose();
  });

  it('rejects an invalid thread id without changing the alias table', () => {
    expect(joinCodex(root, 'codex', 'bad thread').ok).toBe(false);
    expect(getAlias(root, 'codex')).toBeUndefined();
  });
});
