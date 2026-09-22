import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MeshOrchestrator, type MeshScope } from '../../src/agentMesh/meshOrchestrator';
import { AliasFifo } from '../../src/agentMesh/aliasFifo';
import type { MeshAdapter, TurnResult } from '../../src/agentMesh/meshAdapter';
import type { ExchangeState } from '../../src/agentMesh/deliveryState';

/** A controllable fake adapter: records sends, lets tests resolve them. */
class FakeAdapter implements MeshAdapter {
  readonly kind = 'codex' as const;
  readonly observesTurns: boolean;
  readonly sends: string[] = [];
  private resolvers: ((r: TurnResult) => void)[] = [];
  constructor(observesTurns = true) {
    this.observesTurns = observesTurns;
  }
  send(message: string): Promise<TurnResult> {
    this.sends.push(message);
    if (!this.observesTurns) return Promise.resolve({ status: 'completed' });
    return new Promise((resolve) => this.resolvers.push(resolve));
  }
  /** Resolve the next pending observing send. */
  complete(status: TurnResult['status'] = 'completed'): void {
    const r = this.resolvers.shift();
    r?.({ status, finalText: 'done' });
  }
  get pending(): number {
    return this.resolvers.length;
  }
}

interface BoardEvent {
  exchangeId: string;
  from: string;
  to?: string;
  type: string;
  state: ExchangeState;
  detail?: string;
}

let root: string;
let board: BoardEvent[];

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-mesh-orch-'));
  board = [];
});

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

function makeOrchestrator(opts: {
  known?: string[];
  adapters: Record<string, FakeAdapter>;
  scope?: MeshScope;
  owned?: Set<string>;
}) {
  const known = opts.known ?? Object.keys(opts.adapters);
  const owned = opts.owned ?? new Set<string>();
  return new MeshOrchestrator({
    busRoot: root,
    knownAliases: () => known,
    scope: () => opts.scope ?? { workspace: '/ws' },
    onEvent: (e) => board.push(e),
    provider: {
      resolveAdapter: async (alias) => opts.adapters[alias.trim().toLowerCase()],
      isOwned: (alias) => owned.has(alias.trim().toLowerCase()),
      isObserving: (alias) => owned.has(alias.trim().toLowerCase()),
      touchActivity: () => undefined,
      isParked: () => false,
      wake: () => false,
    },
  });
}

async function flush(): Promise<void> {
  // Let the FIFO's async drain settle.
  await new Promise((r) => setTimeout(r, 20));
}

describe('orchestrator: tell + FIFO (M5)', () => {
  it('an observing send goes accepted → started → completed, one at a time', async () => {
    const adapter = new FakeAdapter(true);
    const orch = makeOrchestrator({ adapters: { codex: adapter }, owned: new Set(['codex']) });
    const out = await orch.tell('codex', 'hello');
    expect('error' in out).toBe(false);
    // accepted is written synchronously on enqueue.
    expect(board.filter((e) => e.state === 'accepted').length).toBe(1);
    // The turn has not started until the FIFO runs it.
    await flush();
    const states = board.map((e) => e.state);
    expect(states).toEqual(['accepted', 'started']);
    expect(adapter.sends).toEqual(['hello']);
    adapter.complete('completed');
    await flush();
    expect(board.map((e) => e.state)).toEqual(['accepted', 'started', 'completed']);
  });

  it('a message sent during a running turn queues, not a second turn (M5)', async () => {
    const adapter = new FakeAdapter(true);
    const orch = makeOrchestrator({ adapters: { codex: adapter }, owned: new Set(['codex']) });
    await orch.tell('codex', 'first');
    await flush();
    // first is now 'started' (turn running). Send a second while it runs.
    await orch.tell('codex', 'second');
    await flush();
    // Only ONE send has happened so far; the second is queued (accepted only).
    expect(adapter.sends).toEqual(['first']);
    expect(board.filter((e) => e.state === 'accepted').length).toBe(2);
    expect(board.filter((e) => e.state === 'started').length).toBe(1);
    // Complete the first → the second starts.
    adapter.complete('completed');
    await flush();
    expect(adapter.sends).toEqual(['first', 'second']);
    adapter.complete('completed');
    await flush();
    expect(board.filter((e) => e.state === 'completed').length).toBe(2);
  });

  it('exposes pending messages with their recipient aliases for F-09', async () => {
    const adapter = new FakeAdapter(true);
    const orch = makeOrchestrator({ adapters: { codex: adapter }, owned: new Set(['codex']) });
    await orch.tell('codex', 'first');
    await flush();
    await orch.tell('codex', 'queued line 1\nqueued line 2');

    expect(orch.pendingMessages()).toEqual([
      { alias: 'codex', message: 'queued line 1\nqueued line 2' },
    ]);

    adapter.complete();
    await flush();
    expect(orch.pendingMessages()).toEqual([]);
  });

  it('queue overflow is rejected and reported, never dropped (M5)', async () => {
    // Direct FIFO with a small bound: the bound is on the WAITING queue (the
    // in-flight turn is separate). With bound 1: e1 runs, e2 waits (accepted),
    // e3 overflows and is rejected (reported, not dropped).
    const adapter = new FakeAdapter(true);
    const fifo = new AliasFifo(adapter, {
      bound: 1,
      onEvent: (e) =>
        board.push({
          exchangeId: e.exchangeId,
          from: 'forge',
          to: 'codex',
          type: 'state',
          state: e.state,
          ...(e.detail ? { detail: e.detail } : {}),
        }),
    });
    await fifo.enqueue({ exchangeId: 'e1', message: 'first' });
    await flush(); // e1 is now started (turn running)
    expect((await fifo.enqueue({ exchangeId: 'e2', message: 'second' })).accepted).toBe(true);
    const res = await fifo.enqueue({ exchangeId: 'e3', message: 'third' });
    expect(res.accepted).toBe(false);
    expect(res.queueLength).toBe(1);
    expect(board.some((e) => e.exchangeId === 'e3' && e.state === 'rejected')).toBe(true);
    expect(adapter.sends).toEqual(['first']); // e3 was never sent
  });

  it('a non-observing send stays accepted (no started/completed) (§2)', async () => {
    const adapter = new FakeAdapter(false);
    const orch = makeOrchestrator({ adapters: { codex: adapter } });
    await orch.tell('codex', 'hi');
    await flush();
    // F-03: a non-observing recipient gets the exchange id bound into the
    // message (the verdict-file instruction), so the send carries it.
    expect(adapter.sends).toHaveLength(1);
    expect(adapter.sends[0]).toContain('hi');
    expect(adapter.sends[0]).toContain('.verdict.md');
    const states = board.map((e) => e.state);
    expect(states).toEqual(['accepted']); // no started, no completed
  });

  it('an unknown recipient is rejected with the live list (§4)', async () => {
    const adapter = new FakeAdapter(true);
    const orch = makeOrchestrator({ adapters: { codex: adapter }, known: ['codex'] });
    const out = await orch.tell('ghost', 'hi');
    expect('error' in out).toBe(true);
    if ('error' in out) expect(out.error).toContain('unknown recipient');
  });
});

describe('orchestrator: FIFO single-flight + failure states (M5/§2)', () => {
  it('two concurrent first-use tells install ONE FIFO (no second turn)', async () => {
    const adapter = new FakeAdapter(true);
    let resolveAdapter: (() => void) | undefined;
    const gate = new Promise<void>((r) => (resolveAdapter = r));
    const orch = new MeshOrchestrator({
      busRoot: root,
      knownAliases: () => ['codex'],
      scope: () => ({ workspace: '/ws' }),
      onEvent: (e) => board.push(e),
      provider: {
        // Slow resolution: both tells observe an empty FIFO map before either
        // installs. Without single-flight, two FIFOs would each start a turn.
        resolveAdapter: async () => {
          await gate;
          return adapter;
        },
        isOwned: () => true,
        isObserving: () => true,
        touchActivity: () => undefined,
        isParked: () => false,
        wake: () => false,
      },
    });
    // Both tells run synchronously up to the gate before the next line, so the
    // second one observes the first's in-flight `creating` entry.
    const pa = orch.tell('codex', 'one');
    const pb = orch.tell('codex', 'two');
    resolveAdapter!();
    const [a, b] = await Promise.all([pa, pb]);
    expect('error' in a).toBe(false);
    expect('error' in b).toBe(false);
    await flush();
    // Only the first turn has started; the second is queued behind it. One
    // FIFO serialized them — a second FIFO would have started both at once.
    expect(adapter.sends).toEqual(['one']);
    expect(board.filter((e) => e.state === 'started').length).toBe(1);
    expect(board.filter((e) => e.state === 'accepted').length).toBe(2);
    adapter.complete('completed');
    await flush();
    expect(adapter.sends).toEqual(['one', 'two']);
  });

  it('a send that throws AFTER started ends cancelled, not rejected (§2)', async () => {
    let rejectSend: ((e: Error) => void) | undefined;
    const sendPromise = new Promise<TurnResult>((_, rej) => (rejectSend = rej));
    const throwingAdapter: MeshAdapter = {
      kind: 'codex',
      observesTurns: true,
      // The observing send rejects: the turn began (started was written) but
      // then crashed. started→rejected is illegal, so it must end cancelled.
      send: () => sendPromise,
    };
    const orch = new MeshOrchestrator({
      busRoot: root,
      knownAliases: () => ['codex'],
      scope: () => ({ workspace: '/ws' }),
      onEvent: (e) => board.push(e),
      provider: {
        resolveAdapter: async () => throwingAdapter,
        isOwned: () => true,
        isObserving: () => true,
        touchActivity: () => undefined,
        isParked: () => false,
        wake: () => false,
      },
    });
    await orch.tell('codex', 'boom');
    await flush();
    // started was written before the send threw.
    expect(board.some((e) => e.state === 'started')).toBe(true);
    rejectSend!(new Error('turn crashed'));
    await flush();
    // The terminal state is cancelled (started→rejected is illegal).
    const terminal = board.filter((e) => e.state === 'cancelled' || e.state === 'rejected');
    expect(terminal.map((e) => e.state)).toEqual(['cancelled']);
  });

  it('dispose writes a timeout for each queued-but-unsent message (M5)', async () => {
    const adapter = new FakeAdapter(true);
    const orch = new MeshOrchestrator({
      busRoot: root,
      knownAliases: () => ['codex'],
      scope: () => ({ workspace: '/ws' }),
      onEvent: (e) => board.push(e),
      provider: {
        resolveAdapter: async () => adapter,
        isOwned: () => true,
        isObserving: () => true,
        touchActivity: () => undefined,
        isParked: () => false,
        wake: () => false,
      },
    });
    await orch.tell('codex', 'running'); // starts a turn
    await flush();
    await orch.tell('codex', 'queued-1');
    await orch.tell('codex', 'queued-2');
    await flush();
    // The first turn is active; the other two are queued (accepted, not started).
    expect(board.filter((e) => e.state === 'accepted').length).toBe(3);
    expect(board.filter((e) => e.state === 'started').length).toBe(1);
    orch.dispose();
    // The two queued messages get a terminal timeout; the in-flight one does
    // not (it is covered by its own completion).
    const timeouts = board.filter((e) => e.state === 'timeout');
    expect(timeouts).toHaveLength(2);
  });
});

describe('orchestrator: host-side relay (M6)', () => {
  it('forwards with two hop events sharing one exchange id, zero model turns', async () => {
    const adapter = new FakeAdapter(true);
    const orch = makeOrchestrator({ adapters: { claude: adapter }, owned: new Set(['claude']) });
    const out = await orch.relay('codex', 'claude', 'pass this on');
    expect('error' in out).toBe(false);
    if (!('error' in out)) {
      expect(out.relayed).toBe(true);
      // Two relay hop events share the exchange id.
      const hops = board.filter((e) => e.type === 'relay' && e.exchangeId === out.exchangeId);
      expect(hops).toHaveLength(2);
      // Hop 1: codex → forge (inbound). Hop 2: forge → claude (forward).
      expect(hops[0].from).toBe('codex');
      expect(hops[0].to).toBe('forge');
      expect(hops[1].from).toBe('forge');
      expect(hops[1].to).toBe('claude');
    }
    await flush();
    expect(adapter.sends).toEqual(['pass this on']);
  });

  it('records every relay hop before an idle recipient starts (no late accepted)', async () => {
    // An idle FIFO drains at once, so the recipient's `started` can be written
    // while enqueue is still returning. The real exchange log refuses
    // started -> accepted; mirror that rule so a late hop fails the relay.
    const adapter = new FakeAdapter(true);
    const seen = new Map<string, ExchangeState>();
    const orch = new MeshOrchestrator({
      busRoot: root,
      knownAliases: () => ['codex'],
      scope: () => ({ workspace: '/ws' }),
      onEvent: (e) => {
        if (e.state === 'accepted' && seen.get(e.exchangeId) === 'started') {
          throw new Error('illegal exchange transition started -> accepted');
        }
        seen.set(e.exchangeId, e.state);
      },
      provider: {
        resolveAdapter: async () => adapter,
        isOwned: () => true,
        isObserving: () => true,
        touchActivity: () => undefined,
        isParked: () => false,
        wake: () => false,
      },
    });
    const out = await orch.relay('claude', 'codex', 'are you there');
    expect('error' in out).toBe(false);
    await flush();
    expect(adapter.sends).toEqual(['are you there']);
    adapter.complete();
    orch.dispose();
  });

  it('binds a verdict id when relaying to a non-observing session', async () => {
    const adapter = new FakeAdapter(false);
    const orch = makeOrchestrator({ adapters: { claude: adapter } });

    const out = await orch.relay('codex', 'claude', 'pass this on');
    expect('error' in out).toBe(false);
    await flush();

    expect(adapter.sends[0]).toContain('pass this on');
    expect(adapter.sends[0]).toContain('.verdict.md');
  });

  it('refuses to relay a relay (hop count ≤ 2)', async () => {
    const adapter = new FakeAdapter(true);
    const orch = makeOrchestrator({ adapters: { claude: adapter } });
    const out = await orch.relay('codex', 'claude', 'x', 2);
    expect('error' in out).toBe(true);
    if ('error' in out) expect(out.error).toContain('relay a relay');
  });

  it('an unknown relay recipient is rejected with the live list', async () => {
    const adapter = new FakeAdapter(true);
    const orch = makeOrchestrator({ adapters: { claude: adapter }, known: ['claude'] });
    const out = await orch.relay('codex', 'ghost', 'x');
    expect('error' in out).toBe(true);
  });
});

describe('orchestrator: sender validation (§4)', () => {
  it('accepts forge and known aliases, rejects an unknown sender with the list', () => {
    const adapter = new FakeAdapter(true);
    const orch = makeOrchestrator({ adapters: { codex: adapter }, known: ['codex'] });
    expect(orch.validateFrom('forge')).toEqual({ ok: true });
    expect(orch.validateFrom('codex')).toEqual({ ok: true });
    const bad = orch.validateFrom('mallory');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('mallory');
  });
});

describe('orchestrator: typed lifecycle commands (§8, P3)', () => {
  it('a steer to a parked session wakes it, then sends (§6/§2b)', async () => {
    const adapter = new FakeAdapter(true);
    const parked = new Set<string>(['codex']);
    const orch = new MeshOrchestrator({
      busRoot: root,
      knownAliases: () => ['codex'],
      scope: () => ({ workspace: '/ws' }),
      onEvent: (e) => board.push(e),
      provider: {
        resolveAdapter: async () => adapter,
        isOwned: () => true,
        park: (a) => {
          parked.add(a);
          return true;
        },
        wake: (a) => {
          parked.delete(a);
          return true;
        },
        isParked: (a) => parked.has(a),
        close: async () => true,
        isObserving: () => true,
        touchActivity: () => undefined,
      },
    });
    const out = await orch.handleCommand({ verb: 'steer', alias: 'codex', message: 'stop' });
    expect(out).toContain('steered codex');
    // The steer woke the parked session before sending.
    expect(parked.has('codex')).toBe(false);
    await flush();
    expect(adapter.sends).toEqual(['stop']);
  });

  it('standby parks the session; wake unparks it (§2b)', async () => {
    const parked = new Set<string>();
    const orch = new MeshOrchestrator({
      busRoot: root,
      knownAliases: () => ['codex'],
      scope: () => ({ workspace: '/ws' }),
      onEvent: (e) => board.push(e),
      provider: {
        resolveAdapter: async () => new FakeAdapter(true),
        isOwned: () => true,
        park: (a) => (parked.add(a), true),
        wake: (a) => (parked.delete(a), true),
        isParked: (a) => parked.has(a),
        close: async () => true,
        isObserving: () => true,
        touchActivity: () => undefined,
      },
    });
    expect(await orch.handleCommand({ verb: 'standby', alias: 'codex' })).toContain('parked');
    expect(parked.has('codex')).toBe(true);
    expect(await orch.handleCommand({ verb: 'wake', alias: 'codex' })).toContain('woken');
    expect(parked.has('codex')).toBe(false);
  });
});
