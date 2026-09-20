import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendEvent,
  compact,
  EXCHANGES_LOCK_NAME,
  EXCHANGES_LOG_NAME,
  latestStates,
  newEventId,
  readEvents,
  type ExchangeEvent,
  type ExchangeLogDeps,
  type ExchangeLogPaths,
} from '../../src/agentMesh/exchangeLog';
import type { HostId } from '../../src/agentMesh/hostIdentity';

let root: string;
let paths: ExchangeLogPaths;

/** A single "host" (window) with a fixed identity and a controllable liveness
 *  set, so tests can model "another window is alive". */
function makeHost(pid: number, startedAt: number, alivePids: Set<number>): ExchangeLogDeps {
  return {
    selfPid: pid,
    isAlive: (p) => alivePids.has(p),
    isHostAlive: (h: HostId) => alivePids.has(h.pid),
    processStartMs: (p) => (alivePids.has(p) ? startedAt : undefined),
    lockTimeoutMs: 300,
  };
}

function ev(
  exchangeId: string,
  state: ExchangeEvent['state'],
  ts: number,
  extra: Partial<ExchangeEvent> = {},
): Omit<ExchangeEvent, 'seq'> {
  return {
    eventId: newEventId(),
    ts,
    exchangeId,
    workspace: '/ws',
    from: 'codex',
    to: 'forge',
    type: 'state',
    state,
    ...extra,
  };
}

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-mesh-log-'));
  paths = { log: path.join(root, EXCHANGES_LOG_NAME), lock: path.join(root, EXCHANGES_LOCK_NAME) };
});

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('exchange log (M1/M8)', () => {
  it('appends events and derives the latest state per exchange', async () => {
    const d = makeHost(1, 1000, new Set([1]));
    await appendEvent(paths, ev('x1', 'created', 1), d);
    await appendEvent(paths, ev('x1', 'accepted', 2), d);
    await appendEvent(paths, ev('x2', 'created', 3), d);
    const events = readEvents(paths.log);
    expect(events).toHaveLength(3);
    expect(events[0].seq).toBe(1);
    expect(events[2].seq).toBe(3);
    const states = latestStates(events);
    expect(states.get('x1')).toBe('accepted');
    expect(states.get('x2')).toBe('created');
    expect(fs.existsSync(paths.lock)).toBe(false); // lock released after write
  });

  it('drops a torn last line on read (tolerant parse)', async () => {
    const d = makeHost(1, 1000, new Set([1]));
    await appendEvent(paths, ev('x1', 'created', 1), d);
    await fs.promises.appendFile(paths.log, '{"eventId":"x1","ts":2,  // torn\n', 'utf8');
    const events = readEvents(paths.log);
    expect(events).toHaveLength(1);
  });

  it('skips duplicate event ids on read', async () => {
    const d = makeHost(1, 1000, new Set([1]));
    const id = newEventId();
    await appendEvent(paths, { ...ev('x1', 'created', 1), eventId: id }, d);
    await appendEvent(paths, { ...ev('x1', 'accepted', 2), eventId: id }, d); // dup id
    expect(readEvents(paths.log)).toHaveLength(1);
  });

  it('compacts only whole terminal exchanges, keeping non-terminal ones (M8)', async () => {
    const d = makeHost(1, 1000, new Set([1]));
    // x1: terminal (completed). x2: non-terminal (accepted, no verdict).
    await appendEvent(paths, ev('x1', 'created', 1), d);
    await appendEvent(paths, ev('x1', 'accepted', 2), d);
    await appendEvent(paths, ev('x1', 'started', 3), d);
    await appendEvent(paths, ev('x1', 'completed', 4), d);
    await appendEvent(paths, ev('x2', 'created', 5), d);
    await appendEvent(paths, ev('x2', 'accepted', 6), d);

    const res = await compact(paths, { now: 100, maxExchanges: 1, ttlMs: 1_000_000 }, d);
    // x1 is the only terminal exchange and is within last-N → kept. x2 is
    // non-terminal → kept. Nothing removed yet.
    expect(res.removedExchanges).toBe(0);
    expect(latestStates(readEvents(paths.log)).get('x2')).toBe('accepted');

    // Now make x1 old enough to fall outside last-N AND past the TTL backstop.
    const res2 = await compact(paths, { now: 1_000_000, maxExchanges: 0, ttlMs: 100 }, d);
    const states = latestStates(readEvents(paths.log));
    expect(states.has('x1')).toBe(false); // x1 removed (terminal, old, outside N)
    expect(states.get('x2')).toBe('accepted'); // x2 (non-terminal) survived
    expect(res2.removedExchanges).toBe(1);
  });

  it('never removes a lone transition: all events of a kept exchange stay together', async () => {
    const d = makeHost(1, 1000, new Set([1]));
    await appendEvent(paths, ev('x1', 'created', 1), d);
    await appendEvent(paths, ev('x1', 'accepted', 2), d);
    await appendEvent(paths, ev('x1', 'started', 3), d);
    await appendEvent(paths, ev('x1', 'completed', 4), d);
    await compact(paths, { now: 100, maxExchanges: 5, ttlMs: 1_000_000 }, d);
    const kept = readEvents(paths.log).filter((e) => e.exchangeId === 'x1');
    expect(kept).toHaveLength(4); // whole exchange, not a fragment
  });

  it('a verdict completes a non-observing exchange that stays accepted (F-03)', async () => {
    const d = makeHost(1, 1000, new Set([1]));
    await appendEvent(paths, ev('x1', 'created', 1), d);
    await appendEvent(paths, ev('x1', 'accepted', 2), d); // non-observing: stays accepted
    // A `verdict` event is the exchange-correlated completion: allowed to jump
    // accepted -> completed even though a transport exit never may.
    await appendEvent(
      paths,
      { ...ev('x1', 'completed', 3), type: 'verdict', detail: 'done' },
      d,
    );
    expect(latestStates(readEvents(paths.log)).get('x1')).toBe('completed');
  });

  it('rejects a non-verdict completed on an accepted exchange (transport exit)', async () => {
    const d = makeHost(1, 1000, new Set([1]));
    await appendEvent(paths, ev('x1', 'created', 1), d);
    await appendEvent(paths, ev('x1', 'accepted', 2), d);
    // A bare `completed` (not a verdict) on an accepted exchange is illegal: a
    // transport exit may only advance to accepted.
    await expect(appendEvent(paths, ev('x1', 'completed', 3), d)).rejects.toThrow(
      /illegal exchange transition/,
    );
  });

  it('gives a past-deadline non-terminal exchange a terminal timeout event (M8)', async () => {
    const d = makeHost(1, 1000, new Set([1]));
    await appendEvent(paths, ev('x1', 'created', 1), d);
    await appendEvent(paths, ev('x1', 'accepted', 2), d); // stays accepted, no verdict
    const res = await compact(
      paths,
      { now: 100_000, maxExchanges: 5, ttlMs: 1_000_000, nonTerminalDeadlineMs: 1_000 },
      d,
    );
    expect(res.timedOut).toEqual(['x1']);
    expect(latestStates(readEvents(paths.log)).get('x1')).toBe('timeout');
    // Now it is terminal and can be compacted away.
    const res2 = await compact(
      paths,
      { now: 200_000, maxExchanges: 0, ttlMs: 1_000, nonTerminalDeadlineMs: 1_000 },
      d,
    );
    expect(latestStates(readEvents(paths.log)).has('x1')).toBe(false);
    expect(res2.removedExchanges).toBe(1);
  });

  it('waits on a live holder and gives up after the lock timeout (M1)', async () => {
    const alive = new Set([1, 2]);
    const d1 = makeHost(1, 1000, alive);
    await appendEvent(paths, ev('x1', 'created', 1), d1);
    // Window 2 holds the lock (its host is alive). Window 1 must not steal it.
    fs.writeFileSync(paths.lock, JSON.stringify({ host_pid: 2, host_started_at: 1000 }));
    const d2 = makeHost(1, 1000, alive);
    await expect(appendEvent(paths, ev('x1', 'accepted', 2), d2)).rejects.toThrow(/held by live host/);
    expect(fs.existsSync(paths.lock)).toBe(true); // the live lock was not stolen
  });

  it('reclaims a lock whose holder host is dead (M1)', async () => {
    const alive = new Set([1]); // pid 2 is dead
    fs.writeFileSync(paths.lock, JSON.stringify({ host_pid: 2, host_started_at: 1000 }));
    const d = makeHost(1, 1000, alive);
    await appendEvent(paths, ev('x1', 'created', 1), d); // reclaims the dead lock
    expect(fs.existsSync(paths.lock)).toBe(false);
    expect(readEvents(paths.log)).toHaveLength(1);
  });

  it('reclaims its own leftover lock (never deadlocks on itself)', async () => {
    const d = makeHost(1, 1000, new Set([1]));
    fs.writeFileSync(paths.lock, JSON.stringify({ host_pid: 1, host_started_at: 1000 }));
    await appendEvent(paths, ev('x1', 'created', 1), d);
    expect(readEvents(paths.log)).toHaveLength(1);
  });
});
