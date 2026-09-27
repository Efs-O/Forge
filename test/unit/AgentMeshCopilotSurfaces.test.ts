import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerAlias } from '../../src/agentMesh/aliasRegistry';
import { projectLiveSessions } from '../../src/agentMesh/boardView';
import { setBoardContext, setMeshOrchestrator } from '../../src/agentMesh/meshContext';
import { projectWho, type WhoDeps } from '../../src/agentMesh/meshWho';
import { MeshOrchestrator } from '../../src/agentMesh/meshOrchestrator';
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
  });

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
