import { afterEach, describe, expect, it } from 'vitest';
import { makeTellLiveSessionTool } from '../../src/tools/tellLiveSessionTool';
import { setMeshOrchestrator } from '../../src/agentMesh/meshContext';
import { MeshOrchestrator } from '../../src/agentMesh/meshOrchestrator';
import type { MeshAdapter, TurnResult } from '../../src/agentMesh/meshAdapter';
import type { ExchangeState } from '../../src/agentMesh/deliveryState';
import type { ForgeConfig } from '../../src/config/types';

/** A controllable fake adapter (observing). */
class FakeAdapter implements MeshAdapter {
  readonly kind = 'codex' as const;
  readonly observesTurns = true;
  readonly sends: string[] = [];
  private resolvers: ((r: TurnResult) => void)[] = [];
  send(message: string): Promise<TurnResult> {
    this.sends.push(message);
    return new Promise((resolve) => this.resolvers.push(resolve));
  }
  complete(): void {
    this.resolvers.shift()?.({ status: 'completed', finalText: 'ok' });
  }
}

const adapter = new FakeAdapter();
let board: { state: ExchangeState }[];

function config(enabled = true): ForgeConfig {
  return { agent_bus: { enabled } } as ForgeConfig;
}

function makeTool(enabled = true) {
  board = [];
  const orchestrator = new MeshOrchestrator({
    busRoot: '/tmp',
    knownAliases: () => ['forge', 'codex'],
    scope: () => ({ workspace: '/ws' }),
    onEvent: (e) => board.push({ state: e.state }),
    provider: {
      resolveAdapter: async () => adapter,
      isOwned: () => true,
    },
  });
  setMeshOrchestrator(orchestrator);
  return makeTellLiveSessionTool({ getConfig: () => config(enabled) });
}

afterEach(() => setMeshOrchestrator(undefined));

describe('tell_live_session (§1)', () => {
  it('delivers and returns at once without waiting for a reply', async () => {
    const tool = makeTool();
    const result = await tool.handler({ target: 'codex', message: 'started' }, {});
    const text = typeof result === 'string' ? result : result.text;
    expect(text).toContain('Notified codex');
    expect(text).toContain('notification, not a question');
    // It was accepted + started (owned), and it did NOT block on a reply.
    expect(board.map((e) => e.state)).toEqual(['accepted', 'started']);
    expect(adapter.sends).toEqual(['started']);
    // The turn is still running (not completed) — the tool returned anyway.
    expect(board.some((e) => e.state === 'completed')).toBe(false);
  });

  it('returns at once even while the turn is running (no waitForReply)', async () => {
    const tool = makeTool();
    const started = tool.handler({ target: 'codex', message: 'hi' }, {});
    // Resolve immediately: a blocking ask would not return before the turn ends.
    const result = await started;
    const text = typeof result === 'string' ? result : result.text;
    expect(text).toMatch(/Delivery: started/);
  });

  it('is disabled when agent_bus is off', async () => {
    const tool = makeTool(false);
    await expect(tool.handler({ message: 'hi' }, {})).rejects.toThrow(/disabled/);
  });

  it('requires a message', async () => {
    const tool = makeTool();
    await expect(tool.handler({}, {})).rejects.toThrow(/"message" is required/);
  });

  it('reports an unknown recipient with the live list', async () => {
    const tool = makeTool();
    const result = await tool.handler({ to: 'ghost', message: 'hi' }, {});
    const text = typeof result === 'string' ? result : result.text;
    expect(text).toContain('unknown recipient');
  });
});
