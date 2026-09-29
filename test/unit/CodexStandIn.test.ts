import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeshSessionProvider } from '../../src/agentMesh/sessionProvider';
import {
  CodexStandIn,
  codexStandInNote,
  codexStandInUserNote,
} from '../../src/agentMesh/codexStandIn';
import { CodexQueueAdapter } from '../../src/agentMesh/adapters';
import { ownershipPath } from '../../src/agentMesh/ownership';
import { registerAlias } from '../../src/agentMesh/aliasRegistry';
import type { ForgeConfig } from '../../src/config/types';

type Outcome = 'ok' | 'writer-conflict' | 'mismatch';

/** A fake owned Codex app-server session (no real process). */
class FakeCodexSession {
  disposed = false;
  started = 0;
  constructor(
    private readonly threadId: string | undefined,
    private readonly outcome: Outcome,
  ) {}
  get confirmedSessionId(): string | undefined {
    return this.threadId;
  }
  async ensureStarted(): Promise<void> {
    this.started += 1;
    if (this.outcome === 'writer-conflict') {
      throw new Error(`thread ${this.threadId} already has an active writer`);
    }
    if (this.outcome === 'mismatch') {
      throw new Error('Codex thread/resume returned a mismatched thread id.');
    }
  }
  async send(): Promise<{ status: string; finalText: string }> {
    return { status: 'completed', finalText: 'answered' };
  }
  interrupt(): void {}
  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

let root: string;
let created: { threadId: string | undefined; session: FakeCodexSession }[];
let notices: string[];
let outcome: Outcome;

function makeProvider() {
  const config = {
    agent_bus: { enabled: true, codex_cli: 'codex', codex_thread: '' },
  } as ForgeConfig;
  const queueCodex = vi.fn(async () => undefined);
  const provider = new MeshSessionProvider({
    busRoot: root,
    getConfig: () => config,
    workspaceRoots: () => ['/ws'],
    queueCodex,
    onStandIn: (_alias, note) => notices.push(note),
    codexFactory: {
      create: async ({ threadId }) => {
        const session = new FakeCodexSession(threadId, outcome);
        created.push({ threadId, session });
        return session as never;
      },
    },
    processStartMs: () => 1_700_000_000_000,
  });
  return { provider, queueCodex };
}

function joinUserCodex(threadId: string): void {
  registerAlias(root, 'codex', {
    agent: 'codex',
    session_id: threadId,
    registered_at: 1,
    by: 'user',
  });
}

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-codex-stand-in-'));
  created = [];
  notices = [];
  outcome = 'ok';
});

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('Codex stand-in for a dead user-joined session (through the provider)', () => {
  // Invariant 2 + C4: a stand-in is never an owned session and writes no record.
  it('resumes the alias thread headless, writes no ownership, and leaves the alias untouched', async () => {
    joinUserCodex('thread-7');
    const aliasBefore = fs.readFileSync(path.join(root, 'aliases.json'), 'utf8');
    const { provider } = makeProvider();
    const adapter = await provider.resolveAdapter('codex');
    expect(adapter?.observesTurns).toBe(true);
    expect(created.map((c) => c.threadId)).toEqual(['thread-7']);
    expect(adapter?.note).toBe(codexStandInNote('thread-7'));
    expect(notices).toEqual([codexStandInUserNote('thread-7')]);
    expect(fs.existsSync(ownershipPath(root, 'codex'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'aliases.json'), 'utf8')).toBe(aliasBefore);
    expect(provider.isOwned('codex')).toBe(false);
    await provider.dispose();
  });

  // Invariant 4 + C3: a held thread falls back to the queue adapter, never killed.
  it('on a writer conflict disposes the stand-in and returns the queue adapter, with no note', async () => {
    joinUserCodex('thread-7');
    outcome = 'writer-conflict';
    const { provider, queueCodex } = makeProvider();
    const adapter = await provider.resolveAdapter('codex');
    expect(adapter).toBeInstanceOf(CodexQueueAdapter);
    expect(adapter?.observesTurns).toBe(false);
    expect(created[0]?.session.disposed).toBe(true);
    // The answer goes to the live window, not a stand-in: no stand-in note.
    expect(notices).toEqual([]);
    await adapter?.send('progress note');
    expect(queueCodex).toHaveBeenCalledWith('codex', 'thread-7', 'progress note', undefined);
    await provider.dispose();
  });

  // Invariant 5 + C6: a mismatched-id resume is a plain refusal, no fresh thread.
  it('on a mismatched-id resume returns undefined and a plain failure note', async () => {
    joinUserCodex('thread-7');
    outcome = 'mismatch';
    const { provider } = makeProvider();
    const adapter = await provider.resolveAdapter('codex');
    expect(adapter).toBeUndefined();
    expect(created[0]?.session.disposed).toBe(true);
    // No retry via a fresh thread/start: exactly one creation was attempted.
    expect(created).toHaveLength(1);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('could not resume it');
    await provider.dispose();
  });

  // Invariant 3 + C5: a stale onIdle from a disposed stand-in never tears down
  // the newer one (the `only` guard in disposeStandIn).
  it('a stale onIdle from a disposed stand-in does not dispose the newer one', async () => {
    joinUserCodex('thread-7');
    const { provider } = makeProvider();
    const a = await provider.resolveAdapter('codex');
    a?.onIdle?.();
    await Promise.resolve();
    expect(created[0]?.session.disposed).toBe(true);
    const c = await provider.resolveAdapter('codex');
    expect(c?.key).not.toBe(a?.key);
    // A late onIdle from the disposed stand-in: the newer one must survive.
    a?.onIdle?.();
    await Promise.resolve();
    expect(created[1]?.session.disposed).toBe(false);
    await provider.dispose();
  });

  // Invariant 3 + C5: one-drain lifetime; a fresh stand-in on the next resolve.
  it('is disposed on onIdle, and a later resolve creates a fresh one with a unique key', async () => {
    joinUserCodex('thread-7');
    const { provider } = makeProvider();
    const a = await provider.resolveAdapter('codex');
    const b = await provider.resolveAdapter('codex');
    expect(b).toBe(a);
    expect(notices).toHaveLength(1);
    a?.onIdle?.();
    await Promise.resolve();
    expect(created[0]?.session.disposed).toBe(true);
    const c = await provider.resolveAdapter('codex');
    expect(c?.key).not.toBe(a?.key);
    expect(c?.key).toMatch(/^codex-stand-in:thread-7:/);
    expect(created).toHaveLength(2);
    expect(notices).toHaveLength(2);
    await provider.dispose();
    expect(created[1]?.session.disposed).toBe(true);
  });

  // C5: concurrent resolves share one in-flight creation (no double spawn).
  it('shares one in-flight creation across concurrent resolves', async () => {
    joinUserCodex('thread-7');
    const { provider } = makeProvider();
    const [a, b] = await Promise.all([
      provider.resolveAdapter('codex'),
      provider.resolveAdapter('codex'),
    ]);
    expect(a).toBe(b);
    expect(created).toHaveLength(1);
    await provider.dispose();
  });

  // C5: provider dispose clears a live stand-in.
  it('is disposed when the provider is disposed', async () => {
    joinUserCodex('thread-7');
    const { provider } = makeProvider();
    await provider.resolveAdapter('codex');
    await provider.dispose();
    expect(created[0]?.session.disposed).toBe(true);
  });

  // Invariant 4 + C9: close never targets a user-joined alias, even with a live stand-in.
  it('refuses close on a user-joined alias and leaves the live stand-in running', async () => {
    joinUserCodex('thread-7');
    const { provider } = makeProvider();
    await provider.resolveAdapter('codex');
    const closed = await provider.close('codex');
    expect(closed).toBe(false);
    expect(created[0]?.session.disposed).toBe(false);
    await provider.dispose();
  });
});

describe('CodexStandIn (direct)', () => {
  // Invariant 5 + C6: the only fresh-thread case is an empty alias session id.
  it('an empty session id starts a fresh thread and says it has no context', async () => {
    const createdHere: { threadId: string | undefined }[] = [];
    const noticesHere: string[] = [];
    const standIn = new CodexStandIn({
      busRoot: root,
      getConfig: () => ({ agent_bus: { codex_cli: 'codex' } }) as ForgeConfig,
      workspaceRoots: () => ['/ws'],
      codexFactory: {
        create: async ({ threadId }) => {
          createdHere.push({ threadId });
          return new FakeCodexSession(threadId, 'ok') as never;
        },
      },
      onStandIn: (_a, note) => noticesHere.push(note),
      queueAdapter: async () => undefined,
    });
    const adapter = await standIn.resolve({
      agent: 'codex',
      session_id: '',
      registered_at: 1,
      by: 'user',
    });
    expect(createdHere.map((c) => c.threadId)).toEqual([undefined]);
    // Agent-facing note uses the exact phrase; the user-facing note conveys
    // the same fact with its own wording ("answered without its context").
    expect(adapter?.note).toContain('does NOT have the context');
    expect(noticesHere[0]).toContain('without its context');
    await standIn.dispose();
  });
});
