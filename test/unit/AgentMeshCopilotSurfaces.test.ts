import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerAlias } from '../../src/agentMesh/aliasRegistry';
import { projectLiveSessions } from '../../src/agentMesh/boardView';
import { setBoardContext, setMeshOrchestrator } from '../../src/agentMesh/meshContext';
import { projectWho, type WhoDeps } from '../../src/agentMesh/meshWho';
import { MeshOrchestrator } from '../../src/agentMesh/meshOrchestrator';
import { meshEventNotification } from '../../src/agentMesh/meshNotificationPolicy';
import {
  readOwnership,
  writeOwnership,
  type OwnershipRecord,
} from '../../src/agentMesh/ownership';
import { MeshSessionProvider } from '../../src/agentMesh/sessionProvider';
import { describeAgentBoard, handleRemoteSessionCommand } from '../../src/remote/RemoteSessionCommands';
import { RemoteOutboxDelivery } from '../../src/remote/RemoteOutboxDelivery';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import type { RemoteCommandContext } from '../../src/remote/RemoteCommandHandler';
import type { RemoteInboundEvent } from '../../src/remote/types';
import type { ForgeConfig } from '../../src/config/types';
import { setupAgentMesh } from '../../src/vscode/agentMeshSetup';
import { readEvents } from '../../src/agentMesh/exchangeLog';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';
import type { HostActivityEvent } from '../../src/sidebar/HostActivity';

/** Poll until `predicate` returns a value (the crash-recovery IIFE is fire-and-forget). */
async function waitFor<T>(
  predicate: () => T | undefined | null,
  timeoutMs = 3000,
  intervalMs = 10,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const result = predicate();
    if (result !== undefined && result !== null) return result;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * P3 — Copilot on the operator surfaces (COPILOT_AGENT_MESH_PLAN §P3).
 *
 * The projection and notification owners (boardView, meshWho, the Telegram
 * /status + /queue renderers, the outbox delivery loop) are agent-agnostic:
 * they read the `agent` field off the durable records and carry `copilot`
 * through the same paths as claude/codex. This suite is the P3 test matrix —
 * it asserts the DATA projection AND the Telegram-rendered text, so the
 * sidebar, `forge.sh who`, and Telegram are pinned to agree on Copilot state:
 * truthful live/parked/dead/none, never defaulted to codex, multi-window
 * honest (a foreign live owner is `peer`/`unknown`, not `idle`), an unbound
 * chat shows no board line, a pending Copilot FIFO item carries the agent-bus
 * label, a missing CLI is a plain refusal (no fallback), and a retried
 * notification is delivered once, not duplicated.
 */

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-mesh-copilot-surf-'));
});

afterEach(async () => {
  setBoardContext(undefined);
  setMeshOrchestrator(undefined);
  await fs.rm(root, { recursive: true, force: true });
});

/** Write an ownership record for an alias (the durable state the projections read). */
function own(rec: Partial<OwnershipRecord> & { alias: string }): void {
  writeOwnership(root, {
    agent: rec.agent ?? 'copilot',
    session_id: rec.session_id ?? 'copilot-sess',
    owner_host: rec.owner_host ?? null,
    workspace: rec.workspace ?? '/ws',
    created_at: rec.created_at ?? 1,
    parked: rec.parked ?? false,
    ...(rec.thread_id ? { thread_id: rec.thread_id } : {}),
    ...rec,
  } as OwnershipRecord);
}

/** The in-memory signals `projectWho` reads (the owning window's FIFO, etc.). */
function whoDeps(overrides: Partial<WhoDeps> = {}): WhoDeps {
  return {
    busRoot: root,
    knownAliases: () => ['forge', 'claude', 'codex', 'copilot'],
    isOwner: () => true,
    isBusy: () => false,
    forgeBusy: () => false,
    forgeInboxDepth: () => 0,
    // The fake owner pids are not real processes; the production default (a
    // real OS check) would report them dead. Inject isAlive=true + an unknown
    // start time (unprovable death is treated as alive) to model a live owner.
    hostLiveness: { isAlive: () => true, processStartMs: () => undefined },
    ...overrides,
  };
}

function whoRow(alias: string, deps: WhoDeps = whoDeps()) {
  return projectWho(deps).find((p) => p.alias === alias);
}

describe('P3: forge.sh who renders copilot truthfully (A10)', () => {
  it('an owned, alive, idle copilot is owned+idle (the honest case)', () => {
    own({ alias: 'copilot', owner_host: { pid: 1, startedAt: 1 } });
    expect(whoRow('copilot')).toMatchObject({ attachment: 'owned', activity: 'idle' });
  });

  it('an owned, alive, busy copilot is owned+busy (this host holds its FIFO)', () => {
    own({ alias: 'copilot', owner_host: { pid: 1, startedAt: 1 } });
    expect(whoRow('copilot', whoDeps({ isBusy: () => true }))).toMatchObject({
      attachment: 'owned',
      activity: 'busy',
    });
  });

  it('a parked copilot is owned+parked (warm, thread resumable)', () => {
    own({ alias: 'copilot', owner_host: { pid: 1, startedAt: 1 }, parked: true });
    expect(whoRow('copilot')).toMatchObject({ attachment: 'owned', activity: 'parked' });
  });

  it('a copilot whose owner host is proven dead is owned+dead, thread kept', () => {
    own({ alias: 'copilot', owner_host: { pid: 888, startedAt: 1 }, thread_id: 't1' });
    const deps = whoDeps({
      hostLiveness: { isAlive: (pid) => pid !== 888, processStartMs: () => undefined },
    });
    expect(whoRow('copilot', deps)).toMatchObject({ attachment: 'owned', activity: 'dead' });
    expect(whoRow('copilot', deps)?.detail).toContain('resume');
  });

  it('a copilot a FOREIGN live window owns is peer+unknown, never idle (multi-window)', () => {
    own({ alias: 'copilot', owner_host: { pid: 999, startedAt: 1 } });
    const deps = whoDeps({
      isOwner: () => false, // not this window
      hostLiveness: { isAlive: () => true, processStartMs: () => undefined },
    });
    expect(whoRow('copilot', deps)).toMatchObject({ attachment: 'peer', activity: 'unknown' });
  });

  it('a copilot with no ownership record and no alias is absent from the who table', () => {
    // An alias the system knows nothing about (not registered, not owned, not
    // in knownAliases) does not appear in the who table at all — it is not
    // "none+none", it is simply not a participant.
    expect(whoRow('copilot', whoDeps({ knownAliases: () => ['forge'] }))).toBeUndefined();
  });
});

describe('P3: the sidebar board projection renders copilot truthfully (A10)', () => {
  // ~3.3 s on GitHub windows-latest runners (sync fs churn); the 5 s default flaked the v0.16.74 publish twice.
  it('owned+alive is live, parked is parked, dead owner is dead, no record is none', () => {
    registerAlias(root, 'copilot', { agent: 'copilot', session_id: 's', registered_at: 1, by: 'forge' });
    own({ alias: 'copilot', owner_host: { pid: 1, startedAt: 1 } });
    const deps = { isHostAlive: (h: { pid: number }) => h.pid !== 3 };
    expect(projectLiveSessions(root, deps).find((s) => s.alias === 'copilot')?.state).toBe('live');

    own({ alias: 'copilot', owner_host: { pid: 1, startedAt: 1 }, parked: true });
    expect(projectLiveSessions(root, deps).find((s) => s.alias === 'copilot')?.state).toBe('parked');

    own({ alias: 'copilot', owner_host: { pid: 3, startedAt: 1 } });
    expect(projectLiveSessions(root, deps).find((s) => s.alias === 'copilot')?.state).toBe('dead');

    // A clean close (owner null) is dead, not live.
    own({ alias: 'copilot', owner_host: null });
    expect(projectLiveSessions(root, deps).find((s) => s.alias === 'copilot')?.state).toBe('dead');
  }, 15000);

  it('reports the agent as copilot, never defaulting an unknown agent to codex', () => {
    own({ alias: 'copilot', owner_host: { pid: 1, startedAt: 1 } });
    const row = projectLiveSessions(root).find((s) => s.alias === 'copilot');
    expect(row?.agent).toBe('copilot');
  });

  it('an alias with no ownership record is none (a pin, not a live session)', () => {
    registerAlias(root, 'copilot', { agent: 'copilot', session_id: 's', registered_at: 1, by: 'user' });
    expect(projectLiveSessions(root).find((s) => s.alias === 'copilot')?.state).toBe('none');
  });
});

describe('P3: Telegram /status Sessions line includes copilot live|parked|dead (A10)', () => {
  it('shows copilot live on the Sessions line for a bound chat', () => {
    setBoardContext({ root, workspace: '/ws', log: path.join(root, 'exchanges.jsonl') });
    own({ alias: 'copilot', owner_host: { pid: 1, startedAt: 1 } });
    const out = describeAgentBoard('c1');
    expect(out).toContain('Sessions:');
    expect(out).toContain('copilot live');
  });

  it('shows copilot parked when the session is parked', () => {
    setBoardContext({ root, workspace: '/ws', log: path.join(root, 'exchanges.jsonl') });
    own({ alias: 'copilot', owner_host: { pid: 1, startedAt: 1 }, parked: true });
    expect(describeAgentBoard('c1')).toContain('copilot parked');
  });

  it('shows copilot dead after a clean close (owner_host null)', () => {
    setBoardContext({ root, workspace: '/ws', log: path.join(root, 'exchanges.jsonl') });
    // describeAgentBoard uses projectLiveSessions with no liveness deps, so
    // the default is () => true (always alive). The only way to get "dead"
    // through the Telegram surface is a clean close (owner_host null).
    own({ alias: 'copilot', owner_host: null });
    expect(describeAgentBoard('c1')).toContain('copilot dead');
  });

  it('shows copilot none when there is an alias but no owned session', () => {
    setBoardContext({ root, workspace: '/ws', log: path.join(root, 'exchanges.jsonl') });
    registerAlias(root, 'copilot', { agent: 'copilot', session_id: 's', registered_at: 1, by: 'user' });
    expect(describeAgentBoard('c1')).toContain('copilot none');
  });
});

describe('P3: an unbound remote chat shows no board line, only the live-sessions line (A10)', () => {
  it('renders copilot on the Sessions line but no Board line', () => {
    setBoardContext({ root, workspace: '/ws', log: path.join(root, 'exchanges.jsonl') });
    own({ alias: 'copilot', owner_host: { pid: 1, startedAt: 1 } });
    const out = describeAgentBoard(undefined);
    expect(out).toBeDefined();
    expect(out).not.toContain('Board:');
    expect(out).toContain('Sessions:');
    expect(out).toContain('copilot live');
  });

  it('returns undefined when the agent bus is not up (no board invented)', () => {
    setBoardContext(undefined);
    expect(describeAgentBoard(undefined)).toBeUndefined();
    expect(describeAgentBoard('c1')).toBeUndefined();
  });
});

describe('P3: Telegram /queue lists a pending copilot FIFO item with the agent-bus label (A10)', () => {
  it('renders a queued copilot message as "agent-bus copilot: <first line>"', async () => {
    const store = new RemoteRequestStore(path.join(root, 'state.json'));
    await store.load();
    await store.setBinding({
      channel: 'fake',
      chatId: 'chat-a',
      workspaceId: 'workspace',
      conversationId: 'conversation',
    });
    setMeshOrchestrator({
      pendingMessages: () => [
        { alias: 'copilot', message: 'inspect the build\nthen summarize the result' },
      ],
    } as unknown as MeshOrchestrator);

    const channel = new FakeRemoteChannel();
    const context = {
      channel,
      store,
      signal: new AbortController().signal,
    } as unknown as RemoteCommandContext;
    const event = {
      channel: 'fake',
      kind: 'text',
      providerMessageId: 'queue-copilot',
      senderId: 'owner',
      chatId: 'chat-a',
      chatType: 'private',
      receivedAt: 1,
      text: '/queue',
    } as RemoteInboundEvent;

    await handleRemoteSessionCommand(
      '/queue',
      undefined,
      event as Extract<RemoteInboundEvent, { kind: 'text' }>,
      context,
    );

    const text = channel.sent.at(-1)?.text ?? '';
    expect(text).toContain('agent-bus copilot: inspect the build');
    expect(text).not.toContain('then summarize the result');
    expect(text).toContain('manage them with mesh lifecycle commands');
  });
});

describe('P3: an unavailable Copilot CLI is a plain refusal, never a fallback (A13)', () => {
  /** A provider whose Copilot factory fails (the missing-CLI / spawn-failure path). */
  function providerWithBrokenCli(): MeshSessionProvider {
    return new MeshSessionProvider({
      busRoot: root,
      getConfig: () => ({ agent_bus: { copilot_cli: 'copilot' } }) as ForgeConfig,
      workspaceRoots: () => ['/ws'],
      processStartMs: () => 1_700_000_000_000,
      copilotFactory: {
        create: async () => {
          throw new Error('copilot CLI not found on PATH — install it and log in.');
        },
      },
    });
  }

  it('resolveAdapter returns undefined (no session is created, no other agent is reached)', async () => {
    const p = providerWithBrokenCli();
    const adapter = await p.resolveAdapter('copilot');
    expect(adapter).toBeUndefined();
    // No ownership record is written for a failed creation.
    expect(readOwnership(root, 'copilot')).toBeUndefined();
    await p.dispose();
  });

  it('tell(copilot) reports an actionable no-live-session error, not a fallback', async () => {
    const p = providerWithBrokenCli();
    const board: unknown[] = [];
    const orch = new MeshOrchestrator({
      busRoot: root,
      provider: p,
      scope: () => ({ workspace: '/ws' }),
      onEvent: (e) => void board.push(e),
      knownAliases: () => ['forge', 'copilot'],
    });
    const out = await orch.tell('copilot', 'hello');
    expect('error' in out).toBe(true);
    if ('error' in out) {
      expect(out.error).toContain('no live session');
      expect(out.error).toContain('copilot');
      // No fallback to a different agent: the error names copilot, not claude/codex.
      expect(out.error).not.toContain('claude');
      expect(out.error).not.toContain('codex');
    }
    await p.dispose();
  });
});

describe('P3: a retried copilot notification is delivered once, not duplicated (A11)', () => {
  it('a failed first send retries the SAME outbox item and delivers it exactly once', async () => {
    const store = new RemoteRequestStore(path.join(root, 'state.json'));
    await store.load();
    await store.notifyOutbox('fake', 'chat-a', 'copilot turn finished (exchange abc123)');

    const channel = new FakeRemoteChannel();
    let failNext = true;
    const deliverOnce = channel.send.bind(channel);
    channel.send = async (chatId: string, text: string) => {
      if (failNext) {
        failNext = false;
        throw new Error('network blip');
      }
      return deliverOnce(chatId, text);
    };
    const delivery = new RemoteOutboxDelivery(
      channel,
      store,
      4000,
      new AbortController().signal,
      60_000, // retryDelayMs — large enough that the auto-retry timer never fires during this test
    );

    // First kick: the send fails, the item is retried (marked pending, attempts=1).
    delivery.kick();
    await new Promise((r) => setTimeout(r, 500));
    let pending = store.pendingOutbox('fake');
    expect(pending).toHaveLength(1);
    expect(pending[0].attempts).toBe(1);
    expect(pending[0].state).toBe('pending');
    // Nothing was delivered yet.
    expect(channel.sent.filter((s) => s.text.includes('copilot turn finished'))).toHaveLength(0);

    // Second kick: the send succeeds, the SAME item is delivered and marked delivered.
    delivery.kick();
    await new Promise((r) => setTimeout(r, 500));
    // The notification reached the chat exactly once (no duplicate delivery).
    expect(channel.sent.filter((s) => s.text.includes('copilot turn finished'))).toHaveLength(1);
    // The outbox holds exactly one item for this notification (not a second copy).
    const all = store.pendingOutbox('fake');
    expect(all.filter((item) => item.text.includes('copilot turn finished'))).toHaveLength(0);
    expect(store.outboxHealth().abandoned).toBe(0);
    await delivery.stop();
  });
});

describe('P3: the mesh notification policy phrases terminal events (A11)', () => {
  const scope = { conversation: 'conv-1' };

  it('a completed turn notifies with alias + exchange/state, no prompt', () => {
    const n = meshEventNotification(
      { exchangeId: 'abc123', from: 'forge', to: 'copilot', type: 'state', state: 'completed' },
      scope,
    );
    expect(n?.conversationId).toBe('conv-1');
    expect(n?.text).toContain('copilot');
    expect(n?.text).toContain('completed');
    expect(n?.text).toContain('abc123');
  });

  it('a cancelled turn notifies, and its detail (the answer) is never included', () => {
    const n = meshEventNotification(
      {
        exchangeId: 'abc123',
        from: 'forge',
        to: 'copilot',
        type: 'state',
        state: 'cancelled',
        detail: 'the secret final answer',
      },
      {},
    );
    expect(n?.text).toContain('copilot');
    expect(n?.text).toContain('cancelled');
    expect(n?.text).not.toContain('the secret final answer');
  });

  it('a rejected turn notifies', () => {
    const n = meshEventNotification(
      { exchangeId: 'abc123', from: 'forge', to: 'copilot', type: 'state', state: 'rejected' },
      {},
    );
    expect(n?.text).toContain('copilot');
    expect(n?.text).toContain('rejected');
  });

  it('an idle-TTL timeout (notice) notifies with the system reason', () => {
    const n = meshEventNotification(
      {
        exchangeId: 'idle-copilot',
        from: 'forge',
        to: 'copilot',
        type: 'notice',
        state: 'timeout',
        detail: 'idle TTL reached; session reaped, thread kept for resume',
      },
      scope,
    );
    expect(n?.text).toContain('copilot');
    expect(n?.text).toContain('timeout');
    expect(n?.text).toContain('idle TTL reached');
  });

  it('a crash (notice) notifies with the system reason', () => {
    const n = meshEventNotification(
      {
        exchangeId: 'crash-copilot',
        from: 'forge',
        to: 'copilot',
        type: 'notice',
        state: 'crashed',
        detail: 'owned session lost; thread kept for resume',
      },
      scope,
    );
    expect(n?.text).toContain('copilot');
    expect(n?.text).toContain('crashed');
    expect(n?.text).toContain('owned session lost');
  });

  it('a recovery / stand-in (notice) notifies with the note', () => {
    const n = meshEventNotification(
      {
        exchangeId: 'stand-in-copilot-1',
        from: 'forge',
        to: 'copilot',
        type: 'notice',
        state: 'recovered',
        detail: 'stand-in answering for a dead session',
      },
      scope,
    );
    expect(n?.text).toContain('copilot');
    expect(n?.text).toContain('recovered');
    expect(n?.text).toContain('stand-in answering');
  });

  it('a context-loss (notice) notifies with the system reason', () => {
    const n = meshEventNotification(
      {
        exchangeId: 'context-lost-copilot',
        from: 'forge',
        to: 'copilot',
        type: 'notice',
        state: 'context_lost',
        detail: 'thread resume failed: thread not found',
      },
      scope,
    );
    expect(n?.text).toContain('copilot');
    expect(n?.text).toContain('context_lost');
    expect(n?.text).toContain('thread resume failed');
  });

  it('an accepted event does NOT notify (accepted means queued, not processed)', () => {
    const n = meshEventNotification(
      { exchangeId: 'abc123', from: 'forge', to: 'copilot', type: 'state', state: 'accepted' },
      scope,
    );
    expect(n).toBeUndefined();
  });

  it('created / observed / started do NOT notify (non-terminal)', () => {
    for (const state of ['created', 'observed', 'started'] as const) {
      const n = meshEventNotification(
        { exchangeId: 'abc123', from: 'forge', to: 'copilot', type: 'state', state },
        scope,
      );
      expect(n, state).toBeUndefined();
    }
  });

  it('a window-scoped exchange (no conversation) notifies without a conversationId', () => {
    const n = meshEventNotification(
      { exchangeId: 'abc123', from: 'forge', to: 'copilot', type: 'state', state: 'completed' },
      {},
    );
    expect(n?.conversationId).toBeUndefined();
    expect(n?.text).toContain('copilot');
  });
});

describe('P3: a mesh terminal event reaches the host-activity path (A11 integration)', () => {
  it('a crashed owned copilot emits exactly one host activity naming alias + state', async () => {
    // Isolate the bus under a fake home so the test never touches the real one.
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-mesh-home-'));
    const busRoot = path.join(home, '.forge', 'agent-bus');
    // Pre-seed a copilot ownership record whose owner host is dead (a PID no
    // process holds), so startup recovery reaps it and emits a `crashed` event.
    writeOwnership(busRoot, {
      alias: 'copilot',
      agent: 'copilot',
      session_id: 'copilot-sess',
      thread_id: 't1',
      owner_host: { pid: 2000000, startedAt: 1 },
      workspace: '/ws',
      created_at: 1,
      parked: false,
    });

    const activities: HostActivityEvent[] = [];
    const facade = {
      status: () => ({ activeConversationId: 'conv-1' }),
      emitHostActivity: (event: HostActivityEvent) => {
        activities.push(event);
      },
      hostActivityListenerCount: () => 1,
    } as unknown as ForgeHostFacade;
    const getSidebar = () => ({ getHostFacade: () => facade });
    const getConfig = () => ({ agent_bus: { enabled: true } }) as ForgeConfig;
    const context = { subscriptions: [] as Array<{ dispose(): void }> };

    const mesh = setupAgentMesh(
      context as unknown as Parameters<typeof setupAgentMesh>[0],
      getSidebar,
      getConfig,
      '/ws',
      home,
    );

    try {
      // The crash-recovery IIFE reaps the dead owner and emits the host activity.
      const crashed = await waitFor(() => activities.find((a) => a.text.includes('crashed')));
      expect(crashed.text).toContain('copilot');
      expect(crashed.text).toContain('crashed');
      expect(crashed.conversationId).toBe('conv-1');
      // Exactly one host activity for the crash (no duplicate from onStandIn).
      const crashActivities = activities.filter((a) => a.text.includes('crashed'));
      expect(crashActivities).toHaveLength(1);
    } finally {
      await mesh.dispose();
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

describe('P3: a startup crash with a not-ready facade still recovers and notifies (A11)', () => {
  /** Count durable board events for an exchange id under a fake bus root. */
  const crashCount = (busRoot: string, exchangeId: string): number =>
    readEvents(path.join(busRoot, 'exchanges.jsonl')).filter(
      (e) => e.exchangeId === exchangeId,
    ).length;

  it('a startup crash with getSidebar throwing still recovers, then emits one scoped activity', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-mesh-home-'));
    const busRoot = path.join(home, '.forge', 'agent-bus');
    writeOwnership(busRoot, {
      alias: 'copilot',
      agent: 'copilot',
      session_id: 'copilot-sess',
      thread_id: 't1',
      owner_host: { pid: 2000000, startedAt: 1 },
      workspace: '/ws',
      created_at: 1,
      parked: false,
    });

    const activities: HostActivityEvent[] = [];
    let sidebarReady = false;
    const facade = {
      status: () => ({ activeConversationId: 'conv-1' }),
      emitHostActivity: (event: HostActivityEvent) => {
        activities.push(event);
      },
      hostActivityListenerCount: () => 1,
    } as unknown as ForgeHostFacade;
    const getSidebar = () => {
      if (!sidebarReady) throw new Error('sidebar not ready');
      return { getHostFacade: () => facade };
    };
    const getConfig = () => ({ agent_bus: { enabled: true } }) as ForgeConfig;
    const context = { subscriptions: [] as Array<{ dispose(): void }> };

    const mesh = setupAgentMesh(
      context as unknown as Parameters<typeof setupAgentMesh>[0],
      getSidebar,
      getConfig,
      '/ws',
      home,
    );
    try {
      // The crash-recovery IIFE reaps the dead owner and durably appends the
      // crashed event. The facade is not ready, so the notification is buffered
      // (not emitted, not lost) and onEvent does not reject — recovery completes.
      await waitFor(() => (crashCount(busRoot, 'crash-copilot') > 0 ? true : undefined));
      expect(activities).toHaveLength(0);
      // The sidebar comes up (facade ready, sink subscribed); the retry
      // flushes the buffered crash exactly once.
      sidebarReady = true;
      const crashed = await waitFor(() => activities.find((a) => a.text.includes('crashed')));
      expect(crashed.text).toContain('copilot');
      // The crash happened before the sidebar was up, so the scope is
      // window-scoped (no conversationId): the notification is a snapshot of the
      // event at the time it occurred, not re-derived at flush time.
      expect(crashed.conversationId).toBeUndefined();
      expect(activities.filter((a) => a.text.includes('crashed'))).toHaveLength(1);
    } finally {
      await mesh.dispose();
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('startup recovery continues past the first action when the facade is not ready', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-mesh-home-'));
    const busRoot = path.join(home, '.forge', 'agent-bus');
    // Two dead owned sessions → two reaped recovery actions.
    for (const alias of ['copilot', 'claude']) {
      writeOwnership(busRoot, {
        alias,
        agent: alias,
        session_id: `${alias}-sess`,
        thread_id: `t-${alias}`,
        owner_host: { pid: 2000000, startedAt: 1 },
        workspace: '/ws',
        created_at: 1,
        parked: false,
      });
    }

    const activities: HostActivityEvent[] = [];
    let sidebarReady = false;
    const facade = {
      status: () => ({ activeConversationId: 'conv-1' }),
      emitHostActivity: (event: HostActivityEvent) => {
        activities.push(event);
      },
      hostActivityListenerCount: () => 1,
    } as unknown as ForgeHostFacade;
    const getSidebar = () => {
      if (!sidebarReady) throw new Error('sidebar not ready');
      return { getHostFacade: () => facade };
    };
    const getConfig = () => ({ agent_bus: { enabled: true } }) as ForgeConfig;
    const context = { subscriptions: [] as Array<{ dispose(): void }> };

    const mesh = setupAgentMesh(
      context as unknown as Parameters<typeof setupAgentMesh>[0],
      getSidebar,
      getConfig,
      '/ws',
      home,
    );
    try {
      // Both crashes must be durably appended. In the old code the first
      // onEvent would throw (getSidebar) and abort the recovery loop, so only
      // the first crash would be appended; both being present proves the loop
      // continued past action 1.
      await waitFor(
        () =>
          crashCount(busRoot, 'crash-copilot') > 0 && crashCount(busRoot, 'crash-claude') > 0
            ? true
            : undefined,
      );
      expect(activities).toHaveLength(0); // both buffered, none emitted (facade not ready)
      // The sidebar comes up (facade ready, sink subscribed); both buffered
      // crashes flush, exactly once each.
      sidebarReady = true;
      const crashed = await waitFor(() => {
        const c = activities.filter((a) => a.text.includes('crashed'));
        return c.length >= 2 ? c : undefined;
      });
      expect(crashed).toHaveLength(2);
      const aliases = crashed
        .map((a) => (a.text.includes('copilot') ? 'copilot' : 'claude'))
        .sort();
      expect(aliases).toEqual(['claude', 'copilot']);
      // Both crashes happened before the sidebar was up: window-scoped.
      expect(crashed.every((a) => a.conversationId === undefined)).toBe(true);
    } finally {
      await mesh.dispose();
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('facade available but sink not ready: the startup crash is not dropped, then sink-ready flushes exactly one', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-mesh-home-'));
    const busRoot = path.join(home, '.forge', 'agent-bus');
    writeOwnership(busRoot, {
      alias: 'copilot',
      agent: 'copilot',
      session_id: 'copilot-sess',
      thread_id: 't1',
      owner_host: { pid: 2000000, startedAt: 1 },
      workspace: '/ws',
      created_at: 1,
      parked: false,
    });

    const activities: HostActivityEvent[] = [];
    // The facade is available from the start (the sidebar is up), but no
    // transport has subscribed its onHostActivity listener yet, so the
    // listener count is 0. This is the production order: the facade exists
    // before the transports subscribe.
    let listeners = 0;
    const facade = {
      status: () => ({ activeConversationId: 'conv-1' }),
      emitHostActivity: (event: HostActivityEvent) => {
        activities.push(event);
      },
      hostActivityListenerCount: () => listeners,
    } as unknown as ForgeHostFacade;
    const getSidebar = () => ({ getHostFacade: () => facade });
    const getConfig = () => ({ agent_bus: { enabled: true } }) as ForgeConfig;
    const context = { subscriptions: [] as Array<{ dispose(): void }> };

    const mesh = setupAgentMesh(
      context as unknown as Parameters<typeof setupAgentMesh>[0],
      getSidebar,
      getConfig,
      '/ws',
      home,
    );
    try {
      // The crash is durably appended. The facade is available, but the sink
      // is not ready, so the notification is buffered (NOT emitted into an
      // empty listener set, NOT dropped).
      await waitFor(() => (crashCount(busRoot, 'crash-copilot') > 0 ? true : undefined));
      expect(activities).toHaveLength(0); // buffered, not delivered, not lost
      // A transport subscribes (listener count 0 → 1); the buffered crash
      // flushes exactly once.
      listeners = 1;
      const crashed = await waitFor(() => activities.find((a) => a.text.includes('crashed')));
      expect(crashed.text).toContain('copilot');
      expect(activities.filter((a) => a.text.includes('crashed'))).toHaveLength(1);
    } finally {
      await mesh.dispose();
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
