import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  projectBoard,
  projectLiveSessions,
  stateLabel,
  type BoardRow,
} from '../../src/agentMesh/boardView';
import { appendEvent, newEventId, type ExchangeEvent } from '../../src/agentMesh/exchangeLog';
import { registerAlias } from '../../src/agentMesh/aliasRegistry';
import { writeOwnership } from '../../src/agentMesh/ownership';
import type { HostId } from '../../src/agentMesh/hostIdentity';

let root: string;
let logPath: string;

function ev(partial: Partial<ExchangeEvent> & { exchangeId: string }): Omit<ExchangeEvent, 'seq'> {
  return {
    eventId: partial.eventId ?? newEventId(),
    ts: partial.ts ?? 1000,
    workspace: partial.workspace ?? '/ws',
    conversation: partial.conversation,
    from: partial.from ?? 'forge',
    to: partial.to,
    type: partial.type ?? 'message',
    state: partial.state ?? 'accepted',
    detail: partial.detail,
    ...partial,
  };
}

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-mesh-board-'));
  logPath = path.join(root, 'exchanges.jsonl');
});

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('board projection (P2, §3/M9)', () => {
  it('derives the latest state per exchange, newest first', async () => {
    await appendEvent({ log: logPath, lock: path.join(root, 'exchanges.lock') }, ev({ exchangeId: 'a', state: 'accepted', ts: 1 }));
    await appendEvent({ log: logPath, lock: path.join(root, 'exchanges.lock') }, ev({ exchangeId: 'a', state: 'started', ts: 2 }));
    await appendEvent({ log: logPath, lock: path.join(root, 'exchanges.lock') }, ev({ exchangeId: 'a', state: 'completed', ts: 3 }));
    await appendEvent({ log: logPath, lock: path.join(root, 'exchanges.lock') }, ev({ exchangeId: 'b', state: 'accepted', ts: 4 }));
    const rows = projectBoard(logPath, '/ws', undefined);
    expect(rows.map((r) => r.exchangeId)).toEqual(['b', 'a']); // b is newest
    const a = rows.find((r) => r.exchangeId === 'a') as BoardRow;
    expect(a.state).toBe('completed');
    expect(a.label).toBe('completed');
  }, 15000);

  it('renders non-terminal pre-start states as "queued", never "delivered"', () => {
    expect(stateLabel('accepted')).toBe('queued');
    expect(stateLabel('observed')).toBe('queued');
    expect(stateLabel('created')).toBe('queued');
    expect(stateLabel('completed')).toBe('completed');
    expect(stateLabel('started')).toBe('started');
  });

  it('scopes to a conversation (M9): another conversation is excluded', async () => {
    await appendEvent({ log: logPath, lock: path.join(root, 'exchanges.lock') }, ev({ exchangeId: 'a', conversation: 'c1', state: 'completed', ts: 1 }));
    await appendEvent({ log: logPath, lock: path.join(root, 'exchanges.lock') }, ev({ exchangeId: 'b', conversation: 'c2', state: 'completed', ts: 2 }));
    // Telegram (conversation c1) sees only its own exchange.
    expect(projectBoard(logPath, '/ws', 'c1').map((r) => r.exchangeId)).toEqual(['a']);
    // The sidebar (no conversation) sees the whole workspace.
    expect(projectBoard(logPath, '/ws', undefined).map((r) => r.exchangeId)).toEqual(['b', 'a']);
  });

  it('an event with no conversation is sidebar-only, never in a conversation view (M9)', async () => {
    await appendEvent({ log: logPath, lock: path.join(root, 'exchanges.lock') }, ev({ exchangeId: 'a', state: 'completed', ts: 1 })); // no conversation
    await appendEvent({ log: logPath, lock: path.join(root, 'exchanges.lock') }, ev({ exchangeId: 'b', conversation: 'c1', state: 'completed', ts: 2 }));
    expect(projectBoard(logPath, '/ws', 'c1').map((r) => r.exchangeId)).toEqual(['b']);
    expect(projectBoard(logPath, '/ws', undefined).map((r) => r.exchangeId)).toEqual(['b', 'a']);
  });

  it('honours the limit (last N, newest first)', async () => {
    for (let i = 0; i < 10; i++) {
      await appendEvent({ log: logPath, lock: path.join(root, 'exchanges.lock') }, ev({ exchangeId: `e${i}`, state: 'completed', ts: i + 1 }));
    }
    const rows = projectBoard(logPath, '/ws', undefined, 3);
    expect(rows.map((r) => r.exchangeId)).toEqual(['e9', 'e8', 'e7']);
  }, 15000);

  it('live sessions: owned+alive is live, parked is parked, dead owner is dead, no record is none', () => {
    registerAlias(root, 'codex', { agent: 'codex', session_id: 't', registered_at: 1, by: 'forge' });
    registerAlias(root, 'claude', { agent: 'claude', session_id: 's', registered_at: 1, by: 'user' });
    const live: HostId = { pid: 1, startedAt: 1000 };
    const parked: HostId = { pid: 2, startedAt: 1000 };
    const dead: HostId = { pid: 3, startedAt: 1000 };
    writeOwnership(root, { alias: 'codex', agent: 'codex', session_id: 't', thread_id: 't', owner_host: live, workspace: '/ws', created_at: 1, parked: false });
    writeOwnership(root, { alias: 'claude', agent: 'claude', session_id: 's', owner_host: parked, workspace: '/ws', created_at: 1, parked: true });
    // A third owned alias whose owner host is dead.
    writeOwnership(root, { alias: 'ghost', agent: 'codex', session_id: 'g', owner_host: dead, workspace: '/ws', created_at: 1, parked: false });
    // deps: pids 1 and 2 alive, pid 3 dead.
    const deps = { isHostAlive: (h: HostId) => h.pid !== 3 };
    const sessions = projectLiveSessions(root, deps);
    const by = (a: string) => sessions.find((s) => s.alias === a);
    expect(by('codex')?.state).toBe('live');
    expect(by('claude')?.state).toBe('parked');
    expect(by('ghost')?.state).toBe('dead');
    // An alias with no ownership record and no alias entry is absent; one with
    // an alias but no record is 'none'.
    registerAlias(root, 'pin-only', { agent: 'codex', session_id: 'p', registered_at: 1, by: 'user' });
    expect(projectLiveSessions(root, deps).find((s) => s.alias === 'pin-only')?.state).toBe('none');
  });
});
