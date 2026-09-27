import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MeshSessionProvider } from '../../src/agentMesh/sessionProvider';
import {
  claimCreation,
  readOwnership,
  writeOwnership,
} from '../../src/agentMesh/ownership';
import { getAlias, registerAlias } from '../../src/agentMesh/aliasRegistry';
import { copilotMeshPreamble } from '../../src/agentBus/busContent';
import type { ForgeConfig } from '../../src/config/types';
import type { CliAgentRunResult } from '../../src/agents/types';

// The real start-time reader spawns PowerShell on Windows, slow enough on a
// loaded CI runner to time these tests out.
const selfStart = { processStartMs: () => 1_700_000_000_000 };

/** A controllable fake owned Copilot ACP session (no real process). */
class FakeCopilotSession {
  disposed = false;
  interrupted = false;
  /** Messages this session received (the adapter prepends the preamble). */
  received: string[] = [];
  /** Set by a test to model an id the CLI confirms only on the first turn. */
  confirmOnSend: string | undefined;
  private confirmed: string | undefined;
  constructor(
    confirmed: string | undefined,
    private readonly disposeWait?: Promise<void>,
    private readonly sendError?: Error,
  ) {
    this.confirmed = confirmed;
  }
  get confirmedSessionId(): string | undefined {
    return this.confirmed;
  }
  get pid(): number | undefined {
    return 4242;
  }
  async send(task: string): Promise<CliAgentRunResult> {
    this.received.push(task);
    if (this.sendError) throw this.sendError;
    if (this.confirmOnSend) this.confirmed = this.confirmOnSend;
    return { status: 'completed', finalText: 'done' };
  }
  interrupt(): void {
    this.interrupted = true;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.disposeWait;
  }
}

function makeProvider(
  opts: {
    factory?: (sessionId: string | undefined) => FakeCopilotSession;
    disposeWait?: Promise<void>;
    onContextLost?: (alias: string, reason: string) => void;
  } = {},
): MeshSessionProvider {
  const config: ForgeConfig = {
    agent_bus: { copilot_cli: 'copilot' },
  } as ForgeConfig;
  return new MeshSessionProvider({
    busRoot: root,
    getConfig: () => config,
    workspaceRoots: () => ['/ws'],
    ...selfStart,
    onContextLost: opts.onContextLost,
    copilotFactory: {
      create: async ({ sessionId }) =>
        opts.factory
          ? opts.factory(sessionId)
          : new FakeCopilotSession('owned-id', opts.disposeWait),
    },
  });
}

let root: string;

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-mesh-copilot-'));
});

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('MeshSessionProvider: owned Copilot path (P2)', () => {
  it('resolveAdapter returns the in-memory owned session as an observing adapter', async () => {
    const p = makeProvider();
    const created = await p.resolveAdapter('copilot');
    expect(created).toBeDefined();
    expect(created?.observesTurns).toBe(true);
    expect(created?.kind).toBe('copilot');
    expect(p.isOwned('copilot')).toBe(true);
    await p.dispose();
  });

  it('first creation writes the ownership record and registers the alias', async () => {
    const p = makeProvider();
    await p.resolveAdapter('copilot');
    const rec = readOwnership(root, 'copilot');
    expect(rec?.agent).toBe('copilot');
    expect(rec?.session_id).toBe('owned-id');
    expect(rec?.owner_host?.pid).toBeTypeOf('number');
    // A first owned creation registers the alias as by: 'forge'.
    expect(getAlias(root, 'copilot')?.by).toBe('forge');
    expect(getAlias(root, 'copilot')?.agent).toBe('copilot');
    await p.dispose();
  });

  it('a prior alias session_id resumes owned (M3): the factory gets the id', async () => {
    registerAlias(
      root,
      'copilot',
      { agent: 'copilot', session_id: 'prior-id', registered_at: 1, by: 'user' },
      selfStart,
    );
    const p = makeProvider({ factory: () => new FakeCopilotSession('prior-id') });
    await p.resolveAdapter('copilot');
    expect(readOwnership(root, 'copilot')?.session_id).toBe('prior-id');
    const adapter = await p.resolveAdapter('copilot');
    expect(adapter?.observesTurns).toBe(true);
    await p.dispose();
  });

  it('concurrent first creations spawn exactly one session (creation lease)', async () => {
    let created = 0;
    const p = makeProvider({
      factory: (sid) => {
        created++;
        return new FakeCopilotSession(sid ?? 'owned-id');
      },
    });
    const [a, b] = await Promise.all([p.resolveAdapter('copilot'), p.resolveAdapter('copilot')]);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // One lease → one spawn, even under concurrent first-creation.
    expect(created).toBe(1);
    await p.dispose();
  });

  it('reap disposes the in-memory owned Copilot session', async () => {
    let session: FakeCopilotSession | undefined;
    const p = makeProvider({
      factory: (sid) => (session = new FakeCopilotSession(sid ?? 'owned-id')),
    });
    await p.resolveAdapter('copilot');
    expect(p.isOwned('copilot')).toBe(true);
    await p.reap('copilot');
    expect(session?.disposed).toBe(true);
    expect(p.isOwned('copilot')).toBe(false);
  });

  it('does not resolve a replacement while an owned session is being reaped', async () => {
    let release!: () => void;
    const disposeWait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const p = makeProvider({ disposeWait });
    await p.resolveAdapter('copilot');

    const reaping = p.reap('copilot');
    await Promise.resolve();

    await expect(p.resolveAdapter('copilot')).resolves.toBeUndefined();
    release();
    await reaping;
  });

  it('a losing window refuses when another live window owns the session', async () => {
    const foreign = { pid: 4242, startedAt: 1000 };
    writeOwnership(root, {
      alias: 'copilot',
      agent: 'copilot',
      session_id: 'foreign-id',
      owner_host: foreign,
      workspace: '/ws',
      created_at: 1,
      parked: false,
    });
    claimCreation(root, 'copilot', foreign, {
      selfPid: 9999,
      isAlive: (pid) => pid === foreign.pid || pid === 9999,
      processStartMs: () => 1000,
    });
    const p = new MeshSessionProvider({
      busRoot: root,
      getConfig: () => ({ agent_bus: { copilot_cli: 'copilot' } }) as ForgeConfig,
      workspaceRoots: () => ['/ws'],
      selfPid: 9999,
      isAlive: (pid) => pid === foreign.pid || pid === 9999,
      processStartMs: () => 1000,
    });
    // Copilot has no non-observing fallback: a foreign live owner is a refusal.
    await expect(p.resolveAdapter('copilot')).resolves.toBeUndefined();
  });

  it('close kills the owned session but keeps the record (M3: resumable)', async () => {
    let session: FakeCopilotSession | undefined;
    const p = makeProvider({
      factory: (sid) => (session = new FakeCopilotSession(sid ?? 'owned-id')),
    });
    await p.resolveAdapter('copilot');
    expect(await p.close('copilot')).toBe(true);
    expect(session?.disposed).toBe(true);
    const rec = readOwnership(root, 'copilot');
    expect(rec?.owner_host).toBeNull();
    expect(rec?.session_id).toBe('owned-id');
  });

  it('park and wake flip the parked record; isParked reflects it', async () => {
    const p = makeProvider();
    await p.resolveAdapter('copilot');
    expect(p.isParked('copilot')).toBe(false);
    expect(p.park('copilot')).toBe(true);
    expect(p.isParked('copilot')).toBe(true);
    expect(p.wake('copilot')).toBe(true);
    expect(p.isParked('copilot')).toBe(false);
    await p.dispose();
  });
});

describe('owned Copilot session id + creation preamble', () => {
  it('a fresh session with no id at creation records it after its first turn', async () => {
    const fresh = new FakeCopilotSession(undefined);
    fresh.confirmOnSend = 'confirmed-later';
    const p = makeProvider({ factory: () => fresh });
    const adapter = await p.resolveAdapter('copilot');
    expect(readOwnership(root, 'copilot')?.session_id).toBe('');
    if (adapter) await adapter.send('hi');
    // A reload now resumes this conversation instead of an empty one.
    expect(readOwnership(root, 'copilot')?.session_id).toBe('confirmed-later');
    expect(getAlias(root, 'copilot')?.session_id).toBe('confirmed-later');
    await p.dispose();
  });

  it('sends the one-time creation preamble on a fresh creation', async () => {
    const fresh = new FakeCopilotSession(undefined);
    const p = makeProvider({ factory: () => fresh });
    const adapter = await p.resolveAdapter('copilot');
    expect(adapter).toBeDefined();
    if (adapter) await adapter.send('hello');
    expect(fresh.received).toHaveLength(1);
    expect(fresh.received[0]).toBe(copilotMeshPreamble() + 'hello');
    await p.dispose();
  });

  it('sends the preamble at most once (second turn has no preamble)', async () => {
    const fresh = new FakeCopilotSession(undefined);
    const p = makeProvider({ factory: () => fresh });
    const adapter = await p.resolveAdapter('copilot');
    expect(adapter).toBeDefined();
    if (adapter) {
      await adapter.send('one');
      await adapter.send('two');
    }
    expect(fresh.received[0]).toBe(copilotMeshPreamble() + 'one');
    expect(fresh.received[1]).toBe('two');
    await p.dispose();
  });

  it('sends no preamble on a resumed session (it already knows its identity)', async () => {
    registerAlias(
      root,
      'copilot',
      { agent: 'copilot', session_id: 'prior-id', registered_at: 1, by: 'user' },
      selfStart,
    );
    const resumed = new FakeCopilotSession('prior-id');
    const p = makeProvider({ factory: () => resumed });
    const adapter = await p.resolveAdapter('copilot');
    expect(adapter).toBeDefined();
    if (adapter) await adapter.send('hello');
    expect(resumed.received).toHaveLength(1);
    expect(resumed.received[0]).toBe('hello');
    await p.dispose();
  });
});

describe('owned Copilot context loss + reload (M3)', () => {
  it('a failed RESUME emits context_lost, never a silent fresh session', async () => {
    registerAlias(
      root,
      'copilot',
      { agent: 'copilot', session_id: 'prior-id', registered_at: 1, by: 'user' },
      selfStart,
    );
    const lost: string[] = [];
    const p = makeProvider({
      onContextLost: (alias, reason) => lost.push(`${alias}:${reason}`),
      factory: () => {
        throw new Error('resume failed');
      },
    });
    const adapter = await p.resolveAdapter('copilot');
    expect(adapter).toBeUndefined();
    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain('copilot');
    expect(lost[0]).toContain('resume failed');
  });

  it('a failed fresh creation (no prior id) is a creation error, not a context loss', async () => {
    const lost: string[] = [];
    const p = makeProvider({
      onContextLost: (alias, reason) => lost.push(`${alias}:${reason}`),
      factory: () => {
        throw new Error('spawn failed');
      },
    });
    const adapter = await p.resolveAdapter('copilot');
    expect(adapter).toBeUndefined();
    // No prior session existed, so this is not a context loss.
    expect(lost).toHaveLength(0);
  });

  it('a reload resumes the confirmed id (persistence across dispose)', async () => {
    const first = new FakeCopilotSession(undefined);
    first.confirmOnSend = 'confirmed-later';
    const p1 = makeProvider({ factory: () => first });
    const adapter = await p1.resolveAdapter('copilot');
    if (adapter) await adapter.send('hi');
    expect(readOwnership(root, 'copilot')?.session_id).toBe('confirmed-later');
    await p1.dispose();

    // A new window (new provider) resumes the confirmed id.
    const resumed = new FakeCopilotSession('confirmed-later');
    const p2 = makeProvider({ factory: () => resumed });
    const adapter2 = await p2.resolveAdapter('copilot');
    expect(adapter2).toBeDefined();
    expect(adapter2?.observesTurns).toBe(true);
    // The resumed session is not given a preamble.
    if (adapter2) await adapter2.send('again');
    expect(resumed.received[0]).toBe('again');
    await p2.dispose();
  });
});

describe('owned Copilot process crash (recovery)', () => {
  it('reap disposes the owned child and the record keeps the resumable id', async () => {
    let session: FakeCopilotSession | undefined;
    const p = makeProvider({
      factory: (sid) => (session = new FakeCopilotSession(sid ?? 'crash-id')),
    });
    await p.resolveAdapter('copilot');
    expect(readOwnership(root, 'copilot')?.session_id).toBe('crash-id');
    // Simulate the owner-host-death recovery: the record's owner is cleared by
    // the caller; the provider disposes the in-memory session.
    await p.reap('copilot');
    expect(session?.disposed).toBe(true);
    // The resumable id survives the crash (M3).
    expect(readOwnership(root, 'copilot')?.session_id).toBe('crash-id');
  });
});
