# Weekly audit reproduction evidence

These are characterization probes, not product fixes. Six assert observed defective behavior; C1 checks a rejected hypothesis with serialized event writes. Run against the audit tip `1f282423` or unchanged product sources. No real power control, model call, or Telegram send is performed.

To reproduce, save the TypeScript block below as `test/unit/WeeklyAuditEvidence.test.ts`, then run `npx vitest run test/unit/WeeklyAuditEvidence.test.ts`. Remove that temporary file afterward. Imports intentionally target that location.

Final executed result: 7 tests passed, one file passed, exit 0 (2026-09-21, Windows). The test identifiers F2–F7 are probe IDs; the report uses A1–A11 for ranked findings. C1 is not a finding.

```typescript
// Temporary audit characterization probes: these assert observed defects, not desired behavior.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, expect, it, vi } from 'vitest';
import { AliasFifo } from '../../src/agentMesh/aliasFifo';
import { acquireLock } from '../../src/agentMesh/lock';
import { JobScheduler } from '../../src/jobs/JobScheduler';
import { JobStore, defaultState } from '../../src/jobs/JobStore';
import { JobDelivery } from '../../src/jobs/JobDelivery';
import { JobSchema } from '../../src/jobs/jobSchema';
import { PowerControl } from '../../src/system/PowerControl';
import { FileLease } from '../../src/util/FileLease';
import { TelegramContactService } from '../../src/remote/TelegramContactService';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import { RemoteContactStore } from '../../src/remote/RemoteContactStore';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { ContactInstructionsLoader } from '../../src/remote/ContactInstructionsLoader';
import type { RemoteAuth } from '../../src/remote/RemoteAuth';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';
import { normalizeRequestForModel } from '../../src/llm/RequestNormalizer';
import type { ModelConfig } from '../../src/config/types';

const roots: string[] = [];
function temp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-weekly-audit-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (!path.basename(root).startsWith('forge-weekly-audit-') || path.dirname(root) !== os.tmpdir()) throw new Error('unsafe cleanup');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
const flush = () => new Promise<void>((r) => setImmediate(r));

it('F7: model normalization re-enables thinking that recovery explicitly disabled', () => {
  const result = normalizeRequestForModel({ model: 'nemotron', messages: [], stream: true,
    chat_template_kwargs: { enable_thinking: false } },
  { name: 'nemotron', provider: 'llama.cpp', think: true, chat_template_thinking: true } as ModelConfig);
  expect(result.chat_template_kwargs?.enable_thinking).toBe(true);
});

it('C1: serialized production event writes prevent the suspected FIFO acceptance race', async () => {
  let endA!: () => void;
  let failB!: (e: Error) => void;
  const sent: string[] = [];
  let writes = Promise.resolve();
  const fifo = new AliasFifo({
    kind: 'codex', observesTurns: true, key: 'audit',
    send: async (message) => {
      sent.push(message);
      if (message === 'A') await new Promise<void>((r) => { endA = r; });
      return { status: 'completed' };
    },
  }, { onEvent: (e) => {
    const work = writes.then(() => e.exchangeId === 'B' && e.state === 'accepted'
      ? new Promise<void>((_r, reject) => { failB = reject; }) : undefined);
    writes = work.catch(() => undefined);
    return work;
  } });
  await fifo.enqueue({ exchangeId: 'A', message: 'A' });
  await flush();
  const pending = fifo.enqueue({ exchangeId: 'B', message: 'B' });
  const rejected = expect(pending).rejects.toThrow('disk full');
  endA();
  await flush();
  expect(sent).toEqual(['A']);
  failB(new Error('disk full'));
  await rejected;
  await flush();
  expect(sent).toEqual(['A']);
  fifo.dispose();
});

it('F2: a scheduler that loses initial acquisition installs no takeover timer', async () => {
  const acquire = vi.spyOn(FileLease, 'acquire').mockRejectedValue(new Error('owned'));
  const intervals = vi.spyOn(globalThis, 'setInterval');
  const scheduler = new JobScheduler({ store: new JobStore(temp()), power: new PowerControl(),
    getConfig: () => ({ allowedHosts: [], maxConcurrent: 1 }), workspaceId: 'audit', instanceId: 'audit', leaseDirectory: temp() });
  expect(await scheduler.start()).toBe(false);
  expect(acquire).toHaveBeenCalledOnce();
  expect(intervals).not.toHaveBeenCalled();
  await scheduler.stop();
});

it('F3: actual heartbeat temporary files trigger the job watcher without a job edit', async () => {
  const store = new JobStore(temp());
  await store.ensureDirs();
  let changed!: () => void;
  const noticed = new Promise<void>((r) => { changed = r; });
  const lease = await FileLease.acquire({ directory: store.root, key: 'jobs-scheduler',
    instanceId: 'audit', workspaceId: 'audit', heartbeatMs: 100, onLost: () => {} });
  store.watch(changed);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([noticed, new Promise((_r, reject) => { timeout = setTimeout(() => reject(new Error('no watcher callback')), 4000); })]);
  } finally {
    clearTimeout(timeout);
    store.unwatch();
    await lease.release();
  }
});

it('F4: a crash-left empty mesh lock never recovers even when no host is alive', () => {
  const lock = path.join(temp(), 'audit.lock');
  fs.writeFileSync(lock, '');
  expect(() => acquireLock(lock, { pid: process.pid, startedAt: 1 }, { isHostAlive: () => false }, Date.now() + 30)).toThrow('held by live host pid ?');
  expect(fs.readFileSync(lock, 'utf8')).toBe('');
});

it('F5: paused jobs still invoke a deferred summary and clear its pending flag', async () => {
  const store = new JobStore(temp());
  const job = JobSchema.parse({ version: 1, id: 'audit', name: 'Audit', enabled: false,
    wake: false, after: 'stay_awake', schedule: { kind: 'interval', minutes: 15 },
    check: { kind: 'disk_space', path: store.root, min_free_gb: 1 },
    on_change: { kind: 'summarize', focus: ['release_notes'] }, action: null, created_at: 0, updated_at: 0 });
  await store.saveJob(job);
  store.patchState(job.id, { ...defaultState(), summary_pending: true, last_observation: 'changed' });
  const summarize = vi.fn(async () => 'summary');
  const delivery = new JobDelivery({ store, outboxDir: store.outboxDir, notifyLocal: () => {}, busy: () => undefined, summarize, now: () => 0 });
  await delivery.processPendingSummaries();
  expect(summarize).toHaveBeenCalledOnce();
  expect((await store.load(job.id))!.state.summary_pending).toBe(false);
});

it('F6: an acknowledged contact request survives only as history, with no restart execution', async () => {
  const root = temp();
  const stateFile = path.join(root, 'remote.json');
  const state = new RemoteRequestStore(stateFile);
  await state.load();
  const contacts = new RemoteContactStore(state);
  await contacts.createPending('20', '20');
  const contact = (await contacts.approve(contacts.pending()[0]!.id, 'Audit'))!;
  const link = (await contacts.createGroupLink(contact.id, '-10020', '1'))!;
  await contacts.confirmGroupLink(link.id, '1');
  const channel = new FakeRemoteChannel('telegram');
  const host = { runContactPrompt: vi.fn(async () => 'answer') };
  const auth = { getOwner: async () => '1' } as unknown as RemoteAuth;
  const make = (store: RemoteContactStore) => new TelegramContactService(channel, auth, store, host as unknown as ForgeHostFacade, new ContactInstructionsLoader(root), undefined, undefined, 5000);
  const service = make(contacts);
  const event = { channel: 'telegram' as const, kind: 'text' as const, senderId: '20', chatId: '-10020', chatType: 'group' as const, providerMessageId: '42', receivedAt: Date.now(), text: 'Please answer' };
  expect(await service.handleGroup(event)).toEqual({ kind: 'handled' });
  service.dispose();
  const loaded = new RemoteRequestStore(stateFile);
  await loaded.load();
  const restored = new RemoteContactStore(loaded);
  const next = make(restored);
  try {
    expect(restored.thread(contact.id)).toHaveLength(1);
    await flush();
    expect(host.runContactPrompt).not.toHaveBeenCalled();
    // Redelivery is not idempotent either: providerMessageId isn't retained.
    await next.handleGroup(event);
    expect(restored.thread(contact.id)).toHaveLength(2);
  } finally { next.dispose(); }
});
```
