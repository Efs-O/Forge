import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MeshOrchestrator, type MeshScope } from '../../src/agentMesh/meshOrchestrator';
import type { MeshAdapter, TurnResult } from '../../src/agentMesh/meshAdapter';
import type { ExchangeState } from '../../src/agentMesh/deliveryState';

/**
 * A controllable observing adapter, parameterised by kind so the copilot
 * orchestrator tests exercise the `copilot` alias through the SAME hub-and-spoke
 * path as claude/codex (P2: no Copilot-specific queue, board, or tool surface).
 */
class FakeAdapter implements MeshAdapter {
  readonly kind: 'claude' | 'codex' | 'copilot';
  readonly observesTurns = true;
  readonly key: string;
  readonly sends: string[] = [];
  private resolvers: ((r: TurnResult) => void)[] = [];
  constructor(kind: 'claude' | 'codex' | 'copilot') {
    this.kind = kind;
    this.key = `${kind}-owned`;
  }
  send(message: string): Promise<TurnResult> {
    this.sends.push(message);
    return new Promise((resolve) => this.resolvers.push(resolve));
  }
  complete(status: TurnResult['status'] = 'completed', finalText = 'done'): void {
    this.resolvers.shift()?.({ status, finalText });
  }
}

/**
 * An observing adapter whose `interrupt()` cancels the in-flight turn (the P1
 * Copilot cancellation behavior), so a steer ordering test can observe the
 * interrupted turn settle as `cancelled` and the steer run next.
 */
class InterruptibleAdapter implements MeshAdapter {
  readonly kind = 'copilot' as const;
  readonly observesTurns = true;
  readonly key = 'copilot-owned';
  readonly sends: string[] = [];
  private resolvers: ((r: TurnResult) => void)[] = [];
  send(message: string): Promise<TurnResult> {
    this.sends.push(message);
    return new Promise((resolve) => this.resolvers.push(resolve));
  }
  interrupt(): void {
    this.resolvers.shift()?.({ status: 'cancelled', finalText: '' });
  }
  complete(status: TurnResult['status'] = 'completed'): void {
    this.resolvers.shift()?.({ status, finalText: 'done' });
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
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-mesh-copilot-orch-'));
  board = [];
});

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

function makeOrchestrator(opts: {
  known?: string[];
  adapters: Record<string, MeshAdapter>;
  scope?: MeshScope;
  owned?: Set<string>;
}) {
  const known = opts.known ?? Object.keys(opts.adapters);
  const owned = opts.owned ?? new Set(known);
  return new MeshOrchestrator({
    busRoot: root,
    knownAliases: () => known,
    scope: () => opts.scope ?? { workspace: '/ws' },
    onEvent: (e) => board.push(e),
    provider: {
      resolveAdapter: async (alias) => opts.adapters[alias.trim().toLowerCase()],
      isOwned: (alias) => owned.has(alias.trim().toLowerCase()),
      touchActivity: () => undefined,
      isParked: () => false,
      wake: () => false,
      park: () => false,
      close: async () => true,
    },
  });
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

describe('orchestrator: copilot as a mesh peer (P2)', () => {
  it('FIFO serializes copilot turns: one at a time, the second queues', async () => {
    const copilot = new FakeAdapter('copilot');
    const orch = makeOrchestrator({ adapters: { copilot } });
    await orch.tell('copilot', 'first');
    await flush();
    await orch.tell('copilot', 'second');
    await flush();
    // Only the first turn has started; the second is queued (accepted, not started).
    expect(copilot.sends).toEqual(['first']);
    expect(board.filter((e) => e.state === 'accepted').length).toBe(2);
    expect(board.filter((e) => e.state === 'started').length).toBe(1);
    copilot.complete('completed');
    await flush();
    expect(copilot.sends).toEqual(['first', 'second']);
    copilot.complete('completed');
    await flush();
    expect(board.filter((e) => e.state === 'completed').length).toBe(2);
  });

  it('ask(copilot) returns the observed final answer', async () => {
    const copilot = new FakeAdapter('copilot');
    const orch = makeOrchestrator({ adapters: { copilot } });
    const ask = orch.ask('copilot', 'what is the state?');
    await flush();
    expect(copilot.sends).toEqual(['what is the state?']);
    copilot.complete('completed', 'the observed answer');
    const result = await ask;
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.status).toBe('completed');
      expect(result.finalText).toBe('the observed answer');
    }
  });

  it('tell(copilot) returns at once, reporting the observing (owned) state', async () => {
    const copilot = new FakeAdapter('copilot');
    const orch = makeOrchestrator({ adapters: { copilot }, owned: new Set(['copilot']) });
    const out = await orch.tell('copilot', 'a note');
    expect('error' in out).toBe(false);
    if (!('error' in out)) {
      expect(out.to).toBe('copilot');
      expect(out.observing).toBe(true);
      expect(out.exchangeId).toBeTruthy();
    }
    await flush();
    expect(copilot.sends).toEqual(['a note']);
  });

  it('relays copilot -> claude and claude -> copilot (both directions)', async () => {
    const copilot = new FakeAdapter('copilot');
    const claude = new FakeAdapter('claude');
    const orch = makeOrchestrator({
      adapters: { copilot, claude },
      known: ['copilot', 'claude'],
      owned: new Set(['copilot', 'claude']),
    });

    // copilot -> claude
    const a = await orch.relay('copilot', 'claude', 'from copilot');
    expect('error' in a).toBe(false);
    // claude -> copilot
    const b = await orch.relay('claude', 'copilot', 'from claude');
    expect('error' in b).toBe(false);

    await flush();
    expect(claude.sends).toEqual(['from copilot']);
    expect(copilot.sends).toEqual(['from claude']);

    // Each relay is two accepted hop events after its created row.
    for (const out of [a, b]) {
      if ('error' in out) continue;
      const hops = board.filter(
        (e) => e.type === 'relay' && e.state === 'accepted' && e.exchangeId === out.exchangeId,
      );
      expect(hops).toHaveLength(2);
    }
    // The copilot -> claude relay: hop1 copilot->forge, hop2 forge->claude.
    if (!('error' in a)) {
      const hops = board.filter(
        (e) => e.type === 'relay' && e.state === 'accepted' && e.exchangeId === a.exchangeId,
      );
      expect(hops[0].from).toBe('copilot');
      expect(hops[0].to).toBe('forge');
      expect(hops[1].from).toBe('forge');
      expect(hops[1].to).toBe('claude');
    }
  });

  it('steer(copilot) interrupts the active turn (cancelled) and runs next', async () => {
    const copilot = new InterruptibleAdapter();
    const orch = makeOrchestrator({ adapters: { copilot } });
    const first = await orch.tell('copilot', 'long-running work');
    await flush();
    expect(copilot.sends).toEqual(['long-running work']);
    expect(board.filter((e) => e.state === 'started').length).toBe(1);

    const steer = await orch.steer('copilot', 'stop and do this instead');
    expect('error' in steer).toBe(false);
    await flush();

    // The steer ran next, after the interrupted turn.
    expect(copilot.sends).toEqual(['long-running work', 'stop and do this instead']);
    // The interrupted turn settled as cancelled (not rejected/completed).
    if (!('error' in first)) {
      const firstTerminal = board.filter(
        (e) => e.exchangeId === first.exchangeId && (e.state === 'cancelled' || e.state === 'completed'),
      );
      expect(firstTerminal.map((e) => e.state)).toEqual(['cancelled']);
    }
    // The steer is now the running turn.
    if (!('error' in steer)) {
      expect(board.some((e) => e.exchangeId === steer.exchangeId && e.state === 'started')).toBe(true);
    }
    copilot.complete('completed');
    await flush();
  });

  it('a copilot turn that crashes after started ends cancelled (not rejected)', async () => {
    let rejectSend: ((e: Error) => void) | undefined;
    const crashing: MeshAdapter = {
      kind: 'copilot',
      observesTurns: true,
      send: () => new Promise<TurnResult>((_, rej) => (rejectSend = rej)),
    };
    const orch = makeOrchestrator({ adapters: { copilot: crashing } });
    await orch.tell('copilot', 'boom');
    await flush();
    expect(board.some((e) => e.state === 'started')).toBe(true);
    rejectSend!(new Error('turn crashed'));
    await flush();
    const terminal = board.filter((e) => e.state === 'cancelled' || e.state === 'rejected');
    expect(terminal.map((e) => e.state)).toEqual(['cancelled']);
  });

  it('validateFrom accepts copilot and still rejects an unknown sender', () => {
    const copilot = new FakeAdapter('copilot');
    const orch = makeOrchestrator({ adapters: { copilot }, known: ['copilot'] });
    expect(orch.validateFrom('forge')).toEqual({ ok: true });
    expect(orch.validateFrom('copilot')).toEqual({ ok: true });
    const bad = orch.validateFrom('mallory');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('mallory');
  });

  it('a copilot sender relaying to an unauthorized alias is rejected', async () => {
    const copilot = new FakeAdapter('copilot');
    const orch = makeOrchestrator({ adapters: { copilot }, known: ['copilot'] });
    const out = await orch.relay('copilot', 'ghost', 'x');
    expect('error' in out).toBe(true);
    if ('error' in out) expect(out.error).toContain('unknown recipient');
    // Nothing was delivered.
    expect(copilot.sends).toEqual([]);
  });

  it('tell to an unknown alias is rejected with the live list (no weakening)', async () => {
    const copilot = new FakeAdapter('copilot');
    const orch = makeOrchestrator({ adapters: { copilot }, known: ['copilot'] });
    const out = await orch.tell('ghost', 'hi');
    expect('error' in out).toBe(true);
    if ('error' in out) {
      expect(out.error).toContain('unknown recipient');
      expect(out.error).toContain('copilot');
    }
  });
});
