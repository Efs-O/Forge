import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import { FileLease } from '../../src/util/FileLease';
import { settleRemoteClaim } from '../../src/remote/remoteClaimSettle';
import { drainRemoteQueue, type RemoteQueueDrainDeps } from '../../src/remote/RemoteQueueDrain';
import type { RemoteRequestRecord } from '../../src/remote/types';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-claim-'));
  roots.push(root);
  return {
    root,
    file: path.join(root, 'remote-state-v2.json'),
    leaseDir: path.join(root, 'remote-leases'),
  };
}

function request(id: string, order: number): RemoteRequestRecord {
  return {
    id, dedupKey: id, channel: 'telegram', chatId: 'chat', providerMessageId: id,
    conversationId: 'conv', text: id, receivedAt: order, admittedAt: order,
    state: 'queued', updatedAt: Date.now(),
  };
}

describe('remote claim ownership and recovery', () => {
  it('does not steal another live window’s long claim; recovers after its lease ends', async () => {
    const f = fixture();
    const lease = await FileLease.acquire({
      directory: f.leaseDir, key: 'telegram', workspaceId: 'work',
      instanceId: 'window-a', onLost: () => undefined,
    });
    try {
      const first = new RemoteRequestStore(f.file);
      await first.load();
      first.setClaimOwner('telegram', lease.claimIdentity());
      await first.enqueue(request('one', 1));
      await first.enqueue(request('two', 2));
      expect((await first.claimNext('conv', 'telegram'))?.id).toBe('one');

      const second = new RemoteRequestStore(f.file);
      await second.load();
      expect(second.getRequest('one')?.state).toBe('running');
      expect(await second.claimNext('conv', 'telegram')).toBeUndefined();
    } finally {
      await lease.release();
    }
    const restarted = new RemoteRequestStore(f.file);
    await restarted.load();
    expect(restarted.getRequest('one')?.state).toBe('unknown');
    expect((await restarted.claimNext('conv', 'telegram'))?.id).toBe('two');
  });

  it('migrates an older ownerless running row without stealing a live lease', async () => {
    const f = fixture();
    const lease = await FileLease.acquire({
      directory: f.leaseDir, key: 'telegram', workspaceId: 'work',
      instanceId: 'legacy-window', onLost: () => undefined,
    });
    try {
      const old = new RemoteRequestStore(f.file);
      await old.load();
      await old.enqueue(request('legacy', 1));
      await old.enqueue(request('next', 2));
      await old.markRunning('legacy'); // legacy row has no claimOwner
      const other = new RemoteRequestStore(f.file);
      await other.load();
      expect(other.getRequest('legacy')?.state).toBe('running');
      expect(await other.claimNext('conv', 'telegram')).toBeUndefined();
    } finally {
      await lease.release();
    }
    const restarted = new RemoteRequestStore(f.file);
    await restarted.load();
    expect(restarted.getRequest('legacy')?.state).toBe('unknown');
    expect((await restarted.claimNext('conv', 'telegram'))?.id).toBe('next');
  });

  it('retries a failed terminal write before allowing the successor', async () => {
    const controller = new AbortController();
    const warning = vi.fn();
    let attempts = 0;
    const settled = await settleRemoteClaim(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('disk unavailable');
    }, controller.signal, warning);
    expect(settled).toBe(true);
    expect(attempts).toBe(3);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it('settles the same claimed request after a write failure, then drains the next in order', async () => {
    const f = fixture();
    const store = new RemoteRequestStore(f.file);
    await store.load();
    await store.enqueue(request('one', 1));
    await store.enqueue(request('two', 2));
    const order: string[] = [];
    const realFinish = store.finish.bind(store);
    let failOnce = true;
    vi.spyOn(store, 'finish').mockImplementation(async (...args) => {
      if (args[0] === 'one' && failOnce) {
        failOnce = false;
        order.push('settle-one-failed');
        throw new Error('injected disk failure');
      }
      order.push(`settle-${args[0]}`);
      await realFinish(...args);
    });
    const warnings: string[] = [];
    const deps = {
      signal: new AbortController().signal,
      channel: { name: 'telegram' },
      store,
      auth: { canDeliver: async () => true },
      host: {
        send: async (_conversation: string, text: string) => {
          order.push(`send-${text}`);
          return { kind: 'completed', finalText: text };
        },
      },
      progress: {},
      outbox: { kick: () => undefined },
      activeConversations: new Set<string>(),
      attachmentStore: () => undefined,
      isBusy: () => false,
      onError: (message: string) => warnings.push(message),
    } as unknown as RemoteQueueDrainDeps;
    await drainRemoteQueue('conv', deps);
    expect(order).toEqual([
      'send-one', 'settle-one-failed', 'settle-one', 'send-two', 'settle-two',
    ]);
    expect(store.getRequest('one')?.state).toBe('completed');
    expect(store.getRequest('two')?.state).toBe('completed');
    expect(warnings).toHaveLength(1);
  });
});
