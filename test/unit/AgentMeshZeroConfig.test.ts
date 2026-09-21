import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MeshOrchestrator } from '../../src/agentMesh/meshOrchestrator';
import type { MeshAdapter, TurnResult } from '../../src/agentMesh/meshAdapter';
import { pickClaudePeer, PEER_PROTOCOL, type ClaudeSession } from '../../src/agentBus/claudePeer';
import { joinClaude } from '../../src/agentMesh/claudeJoin';
import { getAlias, readAliases } from '../../src/agentMesh/aliasRegistry';
import { readOwnership, writeOwnership } from '../../src/agentMesh/ownership';
import { forgeInboundPrompt } from '../../src/agentBus/busContent';
import { knownAliasesForMesh } from '../../src/vscode/agentMeshSetup';

/** AGENT_MESH_PLAN §10: zero-config participation. */

class Held implements MeshAdapter {
  readonly kind = 'codex' as const;
  readonly observesTurns = true;
  readonly sends: string[] = [];
  private resolvers: ((r: TurnResult) => void)[] = [];
  constructor(readonly key: string) {}
  send(message: string): Promise<TurnResult> {
    this.sends.push(message);
    return new Promise((resolve) => this.resolvers.push(resolve));
  }
  complete(finalText: string): void {
    this.resolvers.shift()?.({ status: 'completed', finalText });
  }
}

let root: string;
beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-mesh-zc-'));
});
afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

function orch(
  resolve: () => MeshAdapter | undefined,
  knownAliases: () => string[] = () => ['codex'],
): MeshOrchestrator {
  return new MeshOrchestrator({
    busRoot: root,
    knownAliases,
    scope: () => ({ workspace: '/ws' }),
    onEvent: () => undefined,
    provider: {
      resolveAdapter: async () => resolve(),
      isOwned: () => true,
      isObserving: () => true,
      touchActivity: () => undefined,
      isParked: () => false,
      wake: () => false,
    },
  });
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe('orchestrator.ask (§10)', () => {
  it('returns the turn result, and a second ask queues behind the first', async () => {
    const a = new Held('codex-owned');
    const o = orch(() => a);
    const first = o.ask('codex', 'one');
    const second = o.ask('codex', 'two');
    await tick();
    expect(a.sends).toEqual(['one']); // M5: never two turns at once
    a.complete('answer one');
    await expect(first).resolves.toEqual({ status: 'completed', finalText: 'answer one' });
    await tick();
    expect(a.sends).toEqual(['one', 'two']);
    a.complete('answer two');
    await expect(second).resolves.toMatchObject({ finalText: 'answer two' });
  });

  it('an aborted queued ask is withdrawn and never sent', async () => {
    const a = new Held('codex-owned');
    const o = orch(() => a);
    void o.ask('codex', 'one');
    const ctl = new AbortController();
    const second = o.ask('codex', 'two', ctl.signal);
    await tick();
    ctl.abort();
    await expect(second).resolves.toEqual({ status: 'cancelled' });
    a.complete('x');
    await tick();
    expect(a.sends).toEqual(['one']);
  });

  it('an unresolvable alias is an error, not a hang', async () => {
    const o = orch(() => undefined);
    await expect(o.ask('codex', 'hi')).resolves.toHaveProperty('error');
  });

  it('an idle FIFO is rebuilt when the resolved session changes', async () => {
    let current = new Held('claude-peer:1');
    const o = orch(() => current);
    const p1 = o.ask('codex', 'one');
    await tick();
    current.complete('a');
    await p1;
    await tick();
    const old = current;
    current = new Held('claude-peer:2');
    const p2 = o.ask('codex', 'two');
    await tick();
    expect(old.sends).toEqual(['one']);
    expect(current.sends).toEqual(['two']);
    current.complete('b');
    await p2;
  });
});

describe('owned Codex routing with a pending thread id (F2)', () => {
  it('routes send and steer when the owned alias has a blank session id', async () => {
    writeOwnership(root, {
      alias: 'codex',
      agent: 'codex',
      session_id: '',
      owner_host: null,
      workspace: '/ws',
      created_at: 1,
      parked: false,
    });
    expect(readOwnership(root, 'codex')?.session_id).toBe('');
    expect(readAliases(root)).toEqual({});

    const adapter = new Held('codex-owned');
    const o = orch(() => adapter, () => knownAliasesForMesh(root, undefined));
    const sent = await o.tell('codex', 'hello');
    const steered = await o.steer('codex', 'stop');

    expect('error' in sent).toBe(false);
    expect('error' in steered).toBe(false);
    o.dispose();
  });
});

function session(
  pid: number,
  name: string,
  cwd = '/ws',
  extra: Partial<ClaudeSession> = {},
): ClaudeSession {
  return {
    pid,
    name,
    cwd,
    status: 'idle',
    sdk: false,
    pipe: `\\.\pipe\p${pid}`,
    peerProtocol: PEER_PROTOCOL,
    startedAt: pid,
    ...extra,
  };
}

describe('pickClaudePeer (§10)', () => {
  const roots = ['/ws'];
  const many = [session(1, 'a'), session(2, 'b'), session(3, 'c')];

  it('a joined pid wins even when several sessions share the workspace', () => {
    const r = pickClaudePeer(many, { joinedPid: 2 }, roots);
    expect('session' in r && r.session.name).toBe('b');
  });

  it('a stale pin is skipped, not refused', () => {
    const r = pickClaudePeer([session(1, 'only')], { pin: 'forge-dd' }, roots);
    expect('session' in r && r.session.name).toBe('only');
  });

  it('a dead joined pid falls back to the only open session', () => {
    const r = pickClaudePeer([session(5, 'only')], { joinedPid: 99 }, roots);
    expect('session' in r && r.session.name).toBe('only');
  });

  it('an explicit name stays strict', () => {
    const r = pickClaudePeer(many, { explicit: 'zzz', joinedPid: 1 }, roots);
    expect('error' in r).toBe(true);
  });
});

describe('joinClaude (§10)', () => {
  it('registers the claude alias with peer_pid', () => {
    const r = joinClaude(root, 'claude', 7, [session(7, 'forge-93')]);
    expect(r.ok).toBe(true);
    expect(getAlias(root, 'claude')).toMatchObject({
      agent: 'claude',
      session_id: 'forge-93',
      peer_pid: 7,
    });
  });

  it('refuses a pid that is not a live session, or has no pipe', () => {
    expect(joinClaude(root, 'claude', 8, [session(7, 'x')]).ok).toBe(false);
    expect(joinClaude(root, 'claude', 7, [session(7, 'x', '/ws', { pipe: undefined })]).ok).toBe(
      false,
    );
    expect(joinClaude(root, 'codex', 7, [session(7, 'x')]).ok).toBe(false);
    expect(getAlias(root, 'claude')).toBeUndefined();
  });
});

describe('inbound hint (§10)', () => {
  it('answers an alias by target, a named session by session', () => {
    expect(forgeInboundPrompt('claude', 'hi')).toContain('target: "claude"');
    expect(forgeInboundPrompt('codex', 'hi')).toContain('target: "codex"');
    expect(forgeInboundPrompt('forge-dd', 'hi')).toContain('session: "forge-dd"');
  });
});
