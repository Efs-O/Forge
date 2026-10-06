import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteAuth } from '../../src/remote/RemoteAuth';
import { RemoteController } from '../../src/remote/RemoteController';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import type { AgentProgressEvent } from '../../src/sidebar/AgentProgress';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';
import type {
  ToolApprovalRequestEvent,
  ToolApprovalResolvedEvent,
} from '../../src/sidebar/ToolApprovalService';
import type {
  UserQuestionAnsweredEvent,
  UserQuestionRequestEvent,
} from '../../src/sidebar/UserQuestionService';

/**
 * The ⏹ Stop under a turn's newest bubble, end to end through the controller.
 *
 * A tap names the bubble's message id. It must pass the ordinary owner gate,
 * resolve to the live turn that owns the bubble, and cancel only that turn.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  for (const directory of tempDirs.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

async function store(): Promise<RemoteRequestStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-stop-test-'));
  tempDirs.push(directory);
  const result = new RemoteRequestStore(path.join(directory, 'state.json'));
  await result.load();
  return result;
}

class MemorySecrets {
  readonly values = new Map<string, string>();
  get(key: string): Thenable<string | undefined> {
    return Promise.resolve(this.values.get(key));
  }
  store(key: string, value: string): Thenable<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Thenable<void> {
    this.values.delete(key);
    return Promise.resolve();
  }
  onDidChange = vi.fn();
}

const base = {
  channel: 'telegram' as const,
  senderId: 'owner-1',
  chatId: 'chat-1',
  chatType: 'private' as const,
  receivedAt: 1,
};

interface Fixture {
  channel: FakeRemoteChannel;
  controller: RemoteController;
  auth: RemoteAuth;
  host: ForgeHostFacade;
  sent: ForgeHostFacade['send'];
  cancel: ForgeHostFacade['cancel'];
  release: () => void;
  /** Delivers an agent progress event for the live turn, as the host would. */
  emitProgress: (event: AgentProgressEvent) => void;
  /** Resolves once the drain has edited the bubble to this turn's final status. */
  drainDone: () => Promise<void>;
  /** Raises an ask_user gate for the live turn, as the host question service would. */
  askQuestion: (event: UserQuestionRequestEvent) => void;
  answerQuestion: ReturnType<typeof vi.fn>;
  /** Raises a tool-approval gate for the live turn, as AgentLoop would. */
  askApproval: (event: ToolApprovalRequestEvent) => void;
  /** Messages the controller reported through its onError option. */
  errors: string[];
}

/**
 * One fixture, one live turn: a paired owner sends a prompt, the drain opens
 * the turn's bubble, the model's first words stream into it, and `host.send`
 * blocks so the turn is still live while the Stop taps arrive.
 */
async function liveTurn(): Promise<Fixture> {
  const state = await store();
  const secrets = new MemorySecrets();
  const auth = new RemoteAuth(secrets as unknown as vscode.SecretStorage);
  const channel = new FakeRemoteChannel('telegram');

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const errors: string[] = [];
  let progressListener: ((event: AgentProgressEvent) => void) | undefined;
  const answerQuestion = vi.fn(() => true);
  let ask!: (event: UserQuestionRequestEvent) => void;
  let askApproval!: (event: ToolApprovalRequestEvent) => void;
  let resolveApprovalSink!: (event: ToolApprovalResolvedEvent) => void;
  // host.cancel must settle a pending approval the way AgentLoop.cancel does:
  // cancel -> approvals.cancelConversation -> emitResolved(..., 'cancelled').
  // Modelling that here is what makes the Phase 1 x Phase 2 seam testable.
  const pendingApprovals = new Map<string, ToolApprovalRequestEvent>();
  const cancel = vi.fn(async () => {
    for (const event of [...pendingApprovals.values()]) {
      pendingApprovals.delete(event.id);
      resolveApprovalSink({ ...event, approved: false, reason: 'cancelled' });
    }
  });
  const host = {
    createConversation: vi.fn(async () => ({
      id: 'c1',
      title: 'Remote',
      activeModel: 'local',
      archived: false,
    })),
    restoreConversation: vi.fn(),
    send: vi.fn(async () => {
      await gate;
      return { kind: 'cancelled' as const, finalText: '' };
    }),
    cancel,
    onAgentProgress: (listener: (event: AgentProgressEvent) => void) => {
      progressListener = listener;
      return { dispose: () => undefined };
    },
    addApprovalSink: (sink: {
      requested(event: ToolApprovalRequestEvent): void;
      resolved(event: ToolApprovalResolvedEvent): void;
    }) => {
      askApproval = (event) => {
        pendingApprovals.set(event.id, event);
        sink.requested(event);
      };
      resolveApprovalSink = (event) => sink.resolved(event);
      return { dispose: () => undefined };
    },
    resolveApproval: vi.fn((id: string, approved: boolean) => {
      const event = pendingApprovals.get(id);
      if (!event) return;
      pendingApprovals.delete(id);
      resolveApprovalSink({ ...event, approved, reason: 'resolved' as const });
    }),
    addQuestionSink: (sink: {
      asked(event: UserQuestionRequestEvent): void;
      answered(event: UserQuestionAnsweredEvent): void;
    }) => {
      ask = (event) => sink.asked(event);
      return { dispose: () => undefined };
    },
    answerQuestion,
    status: () => ({
      activeConversationId: 'c1',
      conversations: [],
      requestChains: [],
      streamingConversationIds: [],
    }),
  } as unknown as ForgeHostFacade;

  const controller = new RemoteController(channel, state, auth, host, {
    workspaceId: 'workspace',
    queueLimit: 5,
    maxMessageChars: 12_000,
    rateLimitPerMinute: 30,
    onError: (message) => errors.push(message),
  });
  await controller.start();

  const code = auth.beginPairing('telegram');
  await channel.emit({ ...base, kind: 'text', providerMessageId: 'pair', text: `/pair ${code}` });
  await channel.emit({ ...base, kind: 'text', providerMessageId: 'go', text: 'hello' });
  await vi.waitFor(() => expect(host.send).toHaveBeenCalled());
  progressListener?.({ kind: 'commentary', conversationId: 'c1', text: 'Looking at it' });
  await vi.waitFor(() => expect(channel.edits.at(-1)?.text).toContain('Looking at it'), {
    timeout: 3_000,
  });

  return {
    channel,
    controller,
    auth,
    host,
    sent: host.send,
    cancel,
    release,
    emitProgress: (event) => progressListener?.(event),
    drainDone: () =>
      vi.waitFor(() =>
        expect(channel.edits.map((edit) => edit.text)).toContain('Forge: cancelled.'),
      ),
    askQuestion: (event) => ask(event),
    answerQuestion,
    askApproval: (event) => askApproval(event),
    errors,
  };
}

/**
 * The ⏹ Stop under the status bubble, which replaced the native Stop above.
 * The tap names the bubble's message id, and only the turn that owns that
 * bubble may be cancelled.
 */
describe('remote stop_action (newest bubble Stop button)', () => {
  function bubbleId(channel: FakeRemoteChannel): string {
    const index = channel.progress.findIndex((p) => p.text.startsWith('Forge: working'));
    expect(index).toBeGreaterThanOrEqual(0);
    return String(index + 1);
  }

  function tap(messageId: string, providerMessageId: string, overrides = {}): unknown {
    return { ...base, ...overrides, kind: 'stop_action', messageId, providerMessageId };
  }

  it('shows the button for the turn, cancels it on a tap, and drops it at the end', async () => {
    const f = await liveTurn();
    const bubble = bubbleId(f.channel);
    expect(f.channel.stopButtons.has(bubble)).toBe(true);

    await expect(f.channel.emit(tap(bubble, 'cb-1'))).resolves.toEqual({ kind: 'handled' });
    expect(f.cancel).toHaveBeenCalledWith('c1');

    f.release();
    await f.drainDone();
    // The terminal edit takes the button away with the turn.
    expect(f.channel.stopButtons.has(bubble)).toBe(false);
    await f.controller.stop();
  });

  it('ignores a tap on another message or in another chat', async () => {
    const f = await liveTurn();
    const bubble = bubbleId(f.channel);

    const foreign = await f.channel.emit(tap('999', 'cb-foreign'));
    expect(foreign.kind).toBe('rejected');
    const otherChat = await f.channel.emit(tap(bubble, 'cb-chat', { chatId: 'chat-2' }));
    expect(otherChat.kind).toBe('rejected');
    expect(f.cancel).not.toHaveBeenCalled();

    f.release();
    await f.drainDone();
    await f.controller.stop();
  });

  it("does nothing for a finished turn's old bubble", async () => {
    const f = await liveTurn();
    const bubble = bubbleId(f.channel);
    f.release();
    await f.drainDone();

    await expect(f.channel.emit(tap(bubble, 'cb-late'))).resolves.toEqual({
      kind: 'rejected',
      reason: 'This turn has already ended.',
    });
    expect(f.cancel).not.toHaveBeenCalled();
    await f.controller.stop();
  });
});

describe('remote stop_action through the controller', () => {
  function firstBubble(channel: FakeRemoteChannel): string {
    const index = channel.progress.findIndex((p) => p.text.startsWith('Forge: working'));
    expect(index).toBeGreaterThanOrEqual(0);
    return String(index + 1);
  }

  function tap(messageId: string, providerMessageId: string, overrides = {}): unknown {
    return { ...base, ...overrides, kind: 'stop_action', messageId, providerMessageId };
  }

  it('holds a tap behind the auth gate', async () => {
    const state = await store();
    const secrets = new MemorySecrets();
    secrets.values.set('forge.remote.telegram.ownerId', 'someone-else');
    const auth = new RemoteAuth(secrets as unknown as vscode.SecretStorage);
    const channel = new FakeRemoteChannel('telegram');
    const cancel = vi.fn();
    const host = {
      createConversation: vi.fn(),
      restoreConversation: vi.fn(),
      send: vi.fn(),
      cancel,
      addApprovalSink: () => ({ dispose: () => undefined }),
      addQuestionSink: () => ({ dispose: () => undefined }),
      answerQuestion: () => false,
      status: () => ({
        activeConversationId: 'c1',
        conversations: [],
        requestChains: [],
        streamingConversationIds: [],
      }),
    } as unknown as ForgeHostFacade;
    const controller = new RemoteController(channel, state, auth, host, {
      workspaceId: 'workspace',
      queueLimit: 5,
      maxMessageChars: 12_000,
      rateLimitPerMinute: 30,
    });
    await controller.start();

    await expect(
      channel.emit(tap('1', 'stop-stranger', { senderId: 'stranger' })),
    ).resolves.toMatchObject({ kind: 'rejected', reason: 'sender is not paired' });
    await expect(channel.emit(tap('1', 'stop-owner'))).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'sender is not paired',
    });
    expect(cancel).not.toHaveBeenCalled();
    await controller.stop();
  });

  it('refuses a tap in a group chat', async () => {
    const f = await liveTurn();

    await expect(
      f.channel.emit(tap(firstBubble(f.channel), 'stop-group', { chatType: 'group' })),
    ).resolves.toMatchObject({ kind: 'rejected', reason: 'private chats only' });
    expect(f.cancel).not.toHaveBeenCalled();

    f.release();
    await f.drainDone();
    await f.controller.stop();
  });

  it('cancels from the newest bubble after the footer has moved', async () => {
    const f = await liveTurn();
    // A warning is sent below the bubble, so the footer and Stop move to a new
    // bubble under it. That bubble's Stop must still reach the turn.
    f.emitProgress({
      conversationId: 'c1',
      kind: 'notice',
      severity: 'warning',
      text: 'agent is repeating the same tool call',
    });
    await vi.waitFor(() => expect(f.channel.progress.length).toBeGreaterThan(1), {
      timeout: 3_000,
    });
    const newest = String(f.channel.progress.length);
    expect(f.channel.stopButtons.has(newest)).toBe(true);

    await expect(f.channel.emit(tap(newest, 'stop-newest'))).resolves.toEqual({
      kind: 'handled',
    });
    expect(f.cancel).toHaveBeenCalledWith('c1');

    f.release();
    await f.drainDone();
    await f.controller.stop();
  });

  it('cancels an active turn while a question gate is pending, without consuming the Stop', async () => {
    const f = await liveTurn();
    const bubble = firstBubble(f.channel);

    // The question bridge owns this chat's next plain text. A Stop tap is a
    // button update, not text: the question flow must not claim it.
    f.askQuestion({
      id: 'q1',
      prompt: 'Which build?',
      options: ['debug', 'release'],
      conversationId: 'c1',
    });
    await vi.waitFor(() => expect(f.channel.inlineKeyboards).toHaveLength(1));

    await expect(f.channel.emit(tap(bubble, 'stop-while-question'))).resolves.toEqual({
      kind: 'handled',
    });
    expect(f.answerQuestion).not.toHaveBeenCalled();
    expect(f.cancel).toHaveBeenCalledWith('c1');

    // The gate is still live: the chat's next plain text is still the answer.
    await expect(
      f.channel.emit({ ...base, kind: 'text', providerMessageId: 'answer-1', text: 'debug' }),
    ).resolves.toEqual({ kind: 'handled' });
    expect(f.answerQuestion).toHaveBeenCalledWith('q1', 'debug');

    f.release();
    await f.drainDone();
    await f.controller.stop();
  });

  it('reports a Stop whose cancel failed, and still acknowledges the tap', async () => {
    const f = await liveTurn();
    f.host.cancel = vi.fn(async () => {
      throw new Error('host busy');
    });

    // Acknowledged, not retried: a Stop the user meant must not loop.
    await expect(f.channel.emit(tap(firstBubble(f.channel), 'stop-fail'))).resolves.toEqual({
      kind: 'handled',
    });
    await vi.waitFor(() => expect(f.errors).toHaveLength(1));
    expect(f.errors[0]).toContain('could not cancel the turn');
    expect(f.errors[0]).toContain('host busy');

    f.release();
    await f.drainDone();
    await f.controller.stop();
  });

  it('settles a pending approval keyboard when a Stop cancels the turn', async () => {
    const f = await liveTurn();
    const bubble = firstBubble(f.channel);

    // AgentLoop.cancel settles the approval as cancelled, and the Approve/Deny
    // keyboard is greyed out rather than deleted, so no live button is left
    // for a gate that no longer exists.
    f.askApproval({
      id: 'confirm-1',
      toolName: 'exec_command',
      detail: 'run a build',
      dangerous: false,
      conversationId: 'c1',
    });
    await vi.waitFor(() =>
      expect(f.channel.sent.some((m) => m.text.startsWith('Forge approval'))).toBe(true),
    );

    await expect(f.channel.emit(tap(bubble, 'stop-during-approval'))).resolves.toEqual({
      kind: 'handled',
    });
    expect(f.cancel).toHaveBeenCalledWith('c1');

    await vi.waitFor(() => expect(f.channel.resolvedKeyboards).toHaveLength(1));
    expect(f.channel.resolvedKeyboards[0]).toMatchObject({ chatId: 'chat-1', approved: false });
    expect(f.channel.clearedKeyboards).toEqual([]);
    await vi.waitFor(() =>
      expect(f.channel.sent.map((m) => m.text)).toContain('Forge approval denied (cancelled).'),
    );

    f.release();
    await f.drainDone();
    await f.controller.stop();
  });

  it('reports cancellation by editing the bubble, separate from the answer', async () => {
    const f = await liveTurn();

    await f.channel.emit(tap(firstBubble(f.channel), 'stop-1'));
    f.release();
    await f.drainDone();

    expect(f.channel.sent.map((m) => m.text)).not.toContain('Forge: cancelled.');
    const deleted = new Set(f.channel.deleted.map((d) => d.messageId));
    expect([...f.channel.stopButtons].filter((id) => !deleted.has(id))).toEqual([]);
    await f.controller.stop();
  });
});
