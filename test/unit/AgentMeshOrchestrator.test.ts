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
    fifo.enqueue({ exchangeId: 'e1', message: 'first' });
    await flush(); // e1 is now started (turn running)
    expect(fifo.enqueue({ exchangeId: 'e2', message: 'second' }).accepted).toBe(true);
    const res = fifo.enqueue({ exchangeId: 'e3', message: 'third' });
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
    expect(adapter.sends).toEqual(['hi']);
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
