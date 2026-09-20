import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ForgeConfig } from '../../src/config/types';

const codexPinIsLive = vi.hoisted(() => vi.fn());
vi.mock('../../src/agentMesh/codexPinLiveness', () => ({ codexPinIsLive }));

import { validateInboundSender } from '../../src/agentMesh/senderValidation';

let root: string;

afterEach(async () => {
  if (root) await fs.promises.rm(root, { recursive: true, force: true });
  codexPinIsLive.mockReset();
});

describe('inbound sender validation (F-05)', () => {
  it('refuses a stale pin even when the alias list contains the configured name', async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-mesh-sender-'));
    codexPinIsLive.mockResolvedValue(false);
    const config = {
      agent_bus: { codex_thread: 'dead-thread', codex_cli: 'codex' },
    } as ForgeConfig;

    await expect(
      validateInboundSender(
        'codex',
        () => ({ ok: true }),
        root,
        () => config,
        '/ws',
        () => ['forge', 'codex'],
      ),
    ).resolves.toMatchObject({ ok: false });
    expect(codexPinIsLive).toHaveBeenCalledWith('dead-thread', {
      codexCli: 'codex',
      cwd: '/ws',
    });
  });

  it('accepts a configured pin only after liveness is proven', async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-mesh-sender-'));
    codexPinIsLive.mockResolvedValue(true);
    const config = { agent_bus: { codex_thread: 'live-thread' } } as ForgeConfig;

    await expect(
      validateInboundSender('codex', () => ({ ok: false, error: 'unknown' }), root, () => config, '/ws', () => ['forge']),
    ).resolves.toEqual({ ok: true });
  });
});
