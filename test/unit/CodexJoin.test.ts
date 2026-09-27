import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { joinCodex } from '../../src/agentMesh/codexJoin';
import { getAlias } from '../../src/agentMesh/aliasRegistry';
import { codexQueueAdapter } from '../../src/agentMesh/codexPinLiveness';
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
      getConfig: () => ({ agent_bus: { codex_cli: 'codex' } }) as ForgeConfig,
      queueCodex,
    });
    expect(adapter?.observesTurns).toBe(false);
    await adapter?.send('wake supervisor');
    expect(queueCodex).toHaveBeenCalledWith('codex', 'thread-7', 'wake supervisor', undefined);
  });

  it('rejects an invalid thread id without changing the alias table', () => {
    expect(joinCodex(root, 'codex', 'bad thread').ok).toBe(false);
    expect(getAlias(root, 'codex')).toBeUndefined();
  });
});
