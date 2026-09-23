import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MeshSessionProvider } from '../../src/agentMesh/sessionProvider';
import { claudeStandInNote } from '../../src/agentMesh/claudeStandIn';
import { defaultClaudeFactory } from '../../src/agentMesh/creationPreamble';
import { AliasFifo } from '../../src/agentMesh/aliasFifo';
import { ownershipPath } from '../../src/agentMesh/ownership';
import { getAlias, registerAlias } from '../../src/agentMesh/aliasRegistry';
import type { ClaudeSession } from '../../src/agentBus/claudePeer';
import type { ForgeConfig } from '../../src/config/types';

/** A fake owned Claude session (no real process). */
class FakeSession {
  disposed = false;
  constructor(private readonly id: string | undefined) {}
  get confirmedSessionId(): string | undefined {
    return this.id;
  }
  get pid(): number | undefined {
    return 4242;
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
let sessions: ClaudeSession[];
let created: { sessionId: string | undefined; session: FakeSession }[];
let notices: string[];

function makeProvider(confirmed?: (resumeId: string | undefined) => string | undefined) {
  const config = {
    agent_bus: { claude_session: '', codex_thread: '', claude_cli: 'claude' },
  } as ForgeConfig;
  return new MeshSessionProvider({
    busRoot: root,
    getConfig: () => config,
    workspaceRoots: () => ['/ws'],
    claudeSessions: () => sessions,
    sendClaude: async () => undefined,
    onStandIn: (_alias, note) => notices.push(note),
    claudeFactory: {
      create: async ({ sessionId }) => {
        const session = new FakeSession(confirmed ? confirmed(sessionId) : sessionId);
        created.push({ sessionId, session });
        return session as never;
      },
    },
  });
}

function joinDeadPeer(claudeSessionId?: string): void {
  registerAlias(root, 'claude', {
    agent: 'claude',
    session_id: 'forge-4e',
    registered_at: 1,
    by: 'user',
    peer_pid: 99,
    ...(claudeSessionId ? { claude_session_id: claudeSessionId } : {}),
  });
}

const livePanel = (pid: number): ClaudeSession => ({
  pid,
  sessionId: 'conv-1',
  name: 'forge-c6',
  cwd: '/ws',
  status: 'idle',
  sdk: false,
  pipe: 'pipe',
  peerProtocol: 1,
  startedAt: 1,
});

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-stand-in-'));
  sessions = [];
  created = [];
  notices = [];
});

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('Claude stand-in for a dead joined session', () => {
  // The ledger's CI row: a stand-in is never an owned session.
  it('resumes claude_session_id and writes no ownership or alias record', async () => {
    joinDeadPeer('conv-1');
    const aliasBefore = fs.readFileSync(path.join(root, 'aliases.json'), 'utf8');
    const ownershipFile = ownershipPath(root, 'claude');
    const p = makeProvider();
    const adapter = await p.resolveAdapter('claude');
    await adapter?.send('what did we decide?');
    expect(created.map((c) => c.sessionId)).toEqual(['conv-1']);
    expect(adapter?.note).toBe(claudeStandInNote('conv-1'));
    expect(fs.existsSync(ownershipFile)).toBe(false);
    expect(fs.readFileSync(path.join(root, 'aliases.json'), 'utf8')).toBe(aliasBefore);
    expect(p.isOwned('claude')).toBe(false);
    await p.dispose();
  });

  it('tells the user once per stand-in, and reuses it until it goes idle', async () => {
    joinDeadPeer('conv-1');
    const p = makeProvider();
    const a = await p.resolveAdapter('claude');
    const b = await p.resolveAdapter('claude');
    expect(b).toBe(a);
    expect(notices).toEqual([claudeStandInNote('conv-1')]);
    a?.onIdle?.();
    await Promise.resolve();
    expect(created[0]?.session.disposed).toBe(true);
    const c = await p.resolveAdapter('claude');
    expect(c?.key).not.toBe(a?.key);
    expect(notices).toHaveLength(2);
    await p.dispose();
    expect(created[1]?.session.disposed).toBe(true);
  });

  it('is disposed when the joined peer is live again', async () => {
    joinDeadPeer('conv-1');
    const p = makeProvider();
    const standIn = await p.resolveAdapter('claude');
    expect(standIn?.key).toMatch(/^claude-stand-in:conv-1:/);
    // The panel reopened: a new pid, the same conversation id.
    sessions = [livePanel(500)];
    const live = await p.resolveAdapter('claude');
    expect(live?.key).toBe('claude-peer:500');
    expect(created[0]?.session.disposed).toBe(true);
    await p.dispose();
  });

  it('never mistakes its own resumed process for the joined peer', async () => {
    joinDeadPeer('conv-1');
    const p = makeProvider();
    const standIn = await p.resolveAdapter('claude');
    sessions = [livePanel(4242)]; // the stand-in's pid, carrying conv-1
    expect(await p.resolveAdapter('claude')).toBe(standIn);
    expect(created[0]?.session.disposed).toBe(false);
    await p.dispose();
  });

  it('says so when the resume forked into a new session', async () => {
    joinDeadPeer('conv-1');
    const p = makeProvider(() => 'forked-9');
    const adapter = await p.resolveAdapter('claude');
    await adapter?.send('hi');
    expect(notices[1]).toContain('forked-9');
    await p.dispose();
  });

  it('a join without a Claude session id starts blank and says it has no context', async () => {
    joinDeadPeer();
    const p = makeProvider();
    const adapter = await p.resolveAdapter('claude');
    expect(created.map((c) => c.sessionId)).toEqual([undefined]);
    expect(adapter?.note).toContain('does NOT have the context');
    expect(getAlias(root, 'claude')?.peer_pid).toBe(99);
    await p.dispose();
  });

  it('the FIFO calls onIdle once its queue drains', async () => {
    let idle = 0;
    const fifo = new AliasFifo(
      {
        kind: 'claude',
        observesTurns: true,
        send: async () => ({ status: 'completed' }),
        onIdle: () => idle++,
      },
      { onEvent: async () => undefined },
    );
    let settle: () => void = () => undefined;
    const done = new Promise<void>((r) => (settle = r));
    await fifo.enqueue({ exchangeId: 'e1', message: 'one', onResult: () => settle() });
    await done;
    await new Promise((r) => setTimeout(r, 0));
    expect(idle).toBe(1);
  });
});

describe('defaultClaudeFactory', () => {
  it('launches Claude with bypassPermissions (CLAUDE.md § CLI Agent Delegation)', async () => {
    const session = await defaultClaudeFactory().create({
      alias: 'claude',
      sessionId: 'conv-1',
      executable: 'claude',
      cwd: '/ws',
    });
    const options = (session as unknown as { options: { permissionMode?: string } }).options;
    expect(options.permissionMode).toBe('bypassPermissions');
  });
});
