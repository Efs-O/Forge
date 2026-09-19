import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { RemoteRequestStore, remoteDedupKey } from '../../src/remote/RemoteRequestStore';
import type { RemoteRequestRecord } from '../../src/remote/types';

const tempDirs: string[] = [];

async function newStore(): Promise<RemoteRequestStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-remote-scope-'));
  tempDirs.push(directory);
  const store = new RemoteRequestStore(path.join(directory, 'state.json'));
  await store.load();
  return store;
}

afterAll(async () => {
  for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true });
});

let seq = 0;
function request(overrides: Partial<RemoteRequestRecord> = {}): RemoteRequestRecord {
  seq += 1;
  const id = overrides.id ?? `r${seq}`;
  const chatId = overrides.chatId ?? 'chat';
  const providerMessageId = overrides.providerMessageId ?? `m${seq}`;
  return {
    id,
    dedupKey: remoteDedupKey('fake', chatId, providerMessageId),
    channel: 'fake',
    chatId,
    providerMessageId,
    conversationId: overrides.conversationId ?? 'c1',
    text: 'hello',
    receivedAt: Date.now(),
    state: 'queued',
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('requestHealthForConversation (AGENT_MESH_PLAN §5, P1)', () => {
  it('counts only the scoped conversation, not the global total', async () => {
    const store = await newStore();
    await store.enqueue(request({ conversationId: 'c1', state: 'unknown' }));
    await store.enqueue(request({ conversationId: 'c1', state: 'queued' }));
    await store.enqueue(request({ conversationId: 'c2', state: 'unknown' }));
    await store.enqueue(request({ conversationId: 'c2', state: 'running' }));

    expect(store.requestHealthForConversation('c1')).toEqual({
      queued: 1,
      running: 0,
      unknown: 1,
    });
    expect(store.requestHealthForConversation('c2')).toEqual({
      queued: 0,
      running: 1,
      unknown: 1,
    });
    // The global count is the sum — the scoped view is what /status shows.
    expect(store.requestHealth()).toEqual({ queued: 1, running: 1, unknown: 2 });
  });

  it('excludes records without conversation metadata (legacy / unknown-scope)', async () => {
    const store = await newStore();
    // A record with an empty conversationId is treated as unknown-scope and is
    // never attributed to a specific chat.
    await store.enqueue(request({ conversationId: '', state: 'unknown' }));
    await store.enqueue(request({ conversationId: 'c1', state: 'unknown' }));

    expect(store.requestHealthForConversation('c1').unknown).toBe(1);
    // The unscoped unknown is in the global count but in no per-chat count.
    expect(store.requestHealth().unknown).toBe(2);
    expect(store.requestHealthForConversation('c2').unknown).toBe(0);
  });

  it('keeps `unknown` as `unknown` — a reload never auto-resolves it', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-remote-scope-'));
    tempDirs.push(directory);
    const file = path.join(directory, 'state.json');
    const store = new RemoteRequestStore(file);
    await store.load();
    await store.enqueue(request({ conversationId: 'c1', state: 'unknown' }));
    // A request that was running when the process died is flipped to unknown
    // on reload; it is never flipped back to a terminal state.
    await store.enqueue(request({ conversationId: 'c1', state: 'running' }));
    const reloaded = new RemoteRequestStore(file);
    await reloaded.load();
    // The pre-existing unknown survives, and the running one became unknown.
    expect(reloaded.requestHealthForConversation('c1').unknown).toBe(2);
    expect(reloaded.requestHealthForConversation('c1').running).toBe(0);
  });

  it('returns zero for a conversation with no records', async () => {
    const store = await newStore();
    await store.enqueue(request({ conversationId: 'c1', state: 'queued' }));
    expect(store.requestHealthForConversation('nope')).toEqual({
      queued: 0,
      running: 0,
      unknown: 0,
    });
  });
});
