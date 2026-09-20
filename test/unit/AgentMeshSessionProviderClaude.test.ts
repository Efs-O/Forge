import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MeshSessionProvider } from '../../src/agentMesh/sessionProvider';
import { readOwnership } from '../../src/agentMesh/ownership';
import { getAlias, registerAlias } from '../../src/agentMesh/aliasRegistry';
import type { ForgeConfig } from '../../src/config/types';

/** A controllable fake owned Claude session (no real process). */
class FakeClaudeSession {
  disposed = false;
  constructor(private readonly confirmed: string | undefined) {}
  get confirmedSessionId(): string | undefined {
    return this.confirmed;
  }
  get pid(): number | undefined {
    return 4242;
  }
  async send(): Promise<{ status: string; finalText: string }> {
    return { status: 'completed', finalText: 'done' };
  }
  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

function makeProvider(opts: {
  consent?: boolean;
  factory?: (sessionId: string | undefined) => FakeClaudeSession;
} = {}): MeshSessionProvider {
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
    requestConsent: async () => opts.consent ?? true,
    claudeFactory: {
      create: async ({ sessionId }) =>
        opts.factory ? opts.factory(sessionId) : new FakeClaudeSession('owned-id'),
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

  it('ensureOwnedClaude first-creation is consented and writes the ownership record', async () => {
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

  it('a declined first creation starts nothing and writes no record', async () => {
    const p = makeProvider({ consent: false });
    const res = await p.ensureOwnedClaude('claude');
    expect('error' in res).toBe(true);
    if ('error' in res) expect(res.error).toContain('not consented');
    expect(p.isOwned('claude')).toBe(false);
    expect(readOwnership(root, 'claude')).toBeUndefined();
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
    const [a, b] = await Promise.all([p.ensureOwnedClaude('claude'), p.ensureOwnedClaude('claude')]);
    expect('error' in a).toBe(false);
    expect('error' in b).toBe(false);
    // One lease → one spawn, even under concurrent first-creation.
    expect(created).toBe(1);
    await p.dispose();
  });

  it('reap disposes the in-memory owned Claude session', async () => {
    let session: FakeClaudeSession | undefined;
    const p = makeProvider({ factory: (sid) => (session = new FakeClaudeSession(sid ?? 'owned-id')) });
    await p.ensureOwnedClaude('claude');
    expect(p.isOwned('claude')).toBe(true);
    await p.reap('claude');
    expect(session?.disposed).toBe(true);
    expect(p.isOwned('claude')).toBe(false);
  });

  it('close kills the owned session but keeps the record (M3: resumable)', async () => {
    let session: FakeClaudeSession | undefined;
    const p = makeProvider({ factory: (sid) => (session = new FakeClaudeSession(sid ?? 'owned-id')) });
    await p.ensureOwnedClaude('claude');
    expect(await p.close('claude')).toBe(true);
    expect(session?.disposed).toBe(true);
    const rec = readOwnership(root, 'claude');
    expect(rec?.owner_host).toBeNull();
    expect(rec?.session_id).toBe('owned-id');
  });
});
