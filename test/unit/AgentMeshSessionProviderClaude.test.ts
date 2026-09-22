import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MeshSessionProvider } from '../../src/agentMesh/sessionProvider';
import {
  claimCreation,
  readOwnership,
  recordConfirmedId,
  writeOwnership,
} from '../../src/agentMesh/ownership';
import { getAlias, registerAlias } from '../../src/agentMesh/aliasRegistry';
import type { ForgeConfig } from '../../src/config/types';

/** A controllable fake owned Claude session (no real process). */
class FakeClaudeSession {
  disposed = false;
  /** Set by a test to model an id the CLI confirms only on the first turn. */
  confirmOnSend: string | undefined;
  constructor(
    private confirmed: string | undefined,
    private readonly disposeWait?: Promise<void>,
  ) {}
  get confirmedSessionId(): string | undefined {
    return this.confirmed;
  }
  get pid(): number | undefined {
    return 4242;
  }
  async send(): Promise<{ status: string; finalText: string }> {
    if (this.confirmOnSend) this.confirmed = this.confirmOnSend;
    return { status: 'completed', finalText: 'done' };
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.disposeWait;
  }
}

function makeProvider(
  opts: {
    factory?: (sessionId: string | undefined) => FakeClaudeSession;
    disposeWait?: Promise<void>;
  } = {},
): MeshSessionProvider {
  const config: ForgeConfig = {
    agent_bus: { claude_session: '', codex_thread: '', claude_cli: 'claude' },
  } as ForgeConfig;
  return new MeshSessionProvider({
    busRoot: root,
    getConfig: () => config,
    workspaceRoots: () => ['/ws'],
    // No user-opened sessions: the peer/relay fallback is never available, so
    // the owned path is the only Claude door under test.
    claudeSessions: () => [],
    claudeFactory: {
      create: async ({ sessionId }) =>
        opts.factory
          ? opts.factory(sessionId)
          : new FakeClaudeSession('owned-id', opts.disposeWait),
    },
  });
}

let root: string;

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-mesh-claude-'));
});

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('MeshSessionProvider: owned Claude path (P4)', () => {
  it('resolveAdapter returns the in-memory owned session as an observing adapter', async () => {
    const p = makeProvider();
    // Create the owned session (the public creation path).
    const created = await p.ensureOwnedClaude('claude');
    expect('error' in created).toBe(false);
    // A fresh resolveAdapter reuses the in-memory session (no re-spawn).
    const adapter = await p.resolveAdapter('claude');
    expect(adapter).toBeDefined();
    expect(adapter?.observesTurns).toBe(true);
    expect(p.isOwned('claude')).toBe(true);
    await p.dispose();
  });

  it('ensureOwnedClaude first-creation writes the ownership record', async () => {
    const p = makeProvider();
    const res = await p.ensureOwnedClaude('claude');
    expect('error' in res).toBe(false);
    const rec = readOwnership(root, 'claude');
    expect(rec?.agent).toBe('claude');
    expect(rec?.session_id).toBe('owned-id');
    expect(rec?.owner_host?.pid).toBeTypeOf('number');
    // A first owned creation registers the alias as by: 'forge'.
    expect(getAlias(root, 'claude')?.by).toBe('forge');
    await p.dispose();
  });

  it('a joined session that is not running resolves to nothing, not an owned stand-in', async () => {
    // The user's joined panel session is stopped by a VS Code reload until the
    // panel reopens. A stand-in would answer in the user's place.
    registerAlias(root, 'claude', {
      agent: 'claude',
      session_id: 'forge-4e',
      registered_at: 1,
      by: 'user',
      peer_pid: 99,
      claude_session_id: 'conv-1',
    });
    let spawned = 0;
    const p = makeProvider({
      factory: () => {
        spawned++;
        return new FakeClaudeSession('owned-id');
      },
    });
    expect(await p.resolveAdapter('claude')).toBeUndefined();
    expect(spawned).toBe(0);
    await p.dispose();
  });

  it('a prior alias session_id resumes owned (M3): the factory gets the id', async () => {
    registerAlias(root, 'claude', {
      agent: 'claude',
      session_id: 'prior-id',
      registered_at: 1,
      by: 'user',
    });
    const p = makeProvider({ factory: () => new FakeClaudeSession('prior-id') });
    const res = await p.ensureOwnedClaude('claude');
    expect('error' in res).toBe(false);
    const rec = readOwnership(root, 'claude');
    expect(rec?.session_id).toBe('prior-id');
    // resolveAdapter reuses the resumed in-memory session (observing).
    const adapter = await p.resolveAdapter('claude');
    expect(adapter?.observesTurns).toBe(true);
    await p.dispose();
  });

  it('concurrent ensureOwnedClaude calls spawn exactly one session (creation lease, #1)', async () => {
    let created = 0;
    const p = makeProvider({
      factory: (sid) => {
        created++;
        return new FakeClaudeSession(sid ?? 'owned-id');
      },
    });
    const [a, b] = await Promise.all([
      p.ensureOwnedClaude('claude'),
      p.ensureOwnedClaude('claude'),
    ]);
    expect('error' in a).toBe(false);
    expect('error' in b).toBe(false);
    // One lease → one spawn, even under concurrent first-creation.
    expect(created).toBe(1);
    await p.dispose();
  });

  it('reap disposes the in-memory owned Claude session', async () => {
    let session: FakeClaudeSession | undefined;
    const p = makeProvider({
      factory: (sid) => (session = new FakeClaudeSession(sid ?? 'owned-id')),
    });
    await p.ensureOwnedClaude('claude');
    expect(p.isOwned('claude')).toBe(true);
    await p.reap('claude');
    expect(session?.disposed).toBe(true);
    expect(p.isOwned('claude')).toBe(false);
  });

  it('does not resolve a replacement while an owned session is being reaped', async () => {
    let release!: () => void;
    const disposeWait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const p = makeProvider({ disposeWait });
    await p.ensureOwnedClaude('claude');

    const reaping = p.reap('claude');
    await Promise.resolve();

    await expect(p.resolveAdapter('claude')).resolves.toBeUndefined();
    release();
    await reaping;
  });

  it('a losing window falls back after the live creator writes its record', async () => {
    const foreign = { pid: 4242, startedAt: 1000 };
    writeOwnership(root, {
      alias: 'claude',
      agent: 'claude',
      session_id: 'foreign-id',
      owner_host: foreign,
      workspace: '/ws',
      created_at: 1,
      parked: false,
    });
    claimCreation(root, 'claude', foreign, {
      selfPid: 9999,
      isAlive: (pid) => pid === foreign.pid || pid === 9999,
      processStartMs: () => 1000,
    });
    const p = new MeshSessionProvider({
      busRoot: root,
      getConfig: () => ({ agent_bus: { claude_session: '', codex_thread: '' } }) as ForgeConfig,
      workspaceRoots: () => ['/ws'],
      claudeSessions: () => [],
      selfPid: 9999,
      isAlive: (pid) => pid === foreign.pid || pid === 9999,
      processStartMs: () => 1000,
    });

    const result = await p.ensureOwnedClaude('claude');
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain('another window owns');
  });

  it('close kills the owned session but keeps the record (M3: resumable)', async () => {
    let session: FakeClaudeSession | undefined;
    const p = makeProvider({
      factory: (sid) => (session = new FakeClaudeSession(sid ?? 'owned-id')),
    });
    await p.ensureOwnedClaude('claude');
    expect(await p.close('claude')).toBe(true);
    expect(session?.disposed).toBe(true);
    const rec = readOwnership(root, 'claude');
    expect(rec?.owner_host).toBeNull();
    expect(rec?.session_id).toBe('owned-id');
  });
});

describe('owned session id is saved once the first turn confirms it', () => {
  it('a fresh session with no id at creation records it after its first turn', async () => {
    const fresh = new FakeClaudeSession(undefined);
    fresh.confirmOnSend = 'confirmed-later';
    const p = makeProvider({ factory: () => fresh });
    const created = await p.ensureOwnedClaude('claude');
    expect('error' in created).toBe(false);
    expect(readOwnership(root, 'claude')?.session_id).toBe('');
    if (!('error' in created)) await created.send('hi');
    // A reload now resumes this conversation instead of an empty one.
    expect(readOwnership(root, 'claude')?.session_id).toBe('confirmed-later');
    expect(getAlias(root, 'claude')?.session_id).toBe('confirmed-later');
    await p.dispose();
  });

  it('records a Codex thread as both session_id and thread_id', () => {
    writeOwnership(root, {
      alias: 'codex',
      agent: 'codex',
      session_id: '',
      owner_host: null,
      workspace: '/ws',
      created_at: 1,
      parked: false,
    });
    recordConfirmedId(root, 'codex', 'thread-9');
    expect(readOwnership(root, 'codex')).toMatchObject({
      session_id: 'thread-9',
      thread_id: 'thread-9',
    });
    expect(getAlias(root, 'codex')).toMatchObject({ session_id: 'thread-9', by: 'forge' });
  });

  it('never overwrites a joined user session alias', () => {
    registerAlias(root, 'claude', {
      agent: 'claude',
      session_id: 'forge-4e',
      registered_at: 1,
      by: 'user',
      peer_pid: 7,
    });
    recordConfirmedId(root, 'claude', 'owned-x');
    expect(getAlias(root, 'claude')?.session_id).toBe('forge-4e');
  });
});
