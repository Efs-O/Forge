import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteAuth } from '../../src/remote/RemoteAuth';
import { RemoteController } from '../../src/remote/RemoteController';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import type { RichDraftTransport } from '../../src/remote/telegramRichDraft';
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
 * Phase 2: Telegram's native Stop button, end to end through the controller.
 *
 * A `generation_stopped` event arrives with a chat id and a draft id and no
 * sender, so three things must all hold before anything is cancelled: the
 * ordinary owner gate must pass on the derived identity, the chat+draft pair
 * must match a live draft, and a redelivered Stop must not cancel a second
 * time — nor a later turn.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  for (const directory of tempDirs.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

async function store(): Promise<RemoteRequestStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-draft-test-'));
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
  /** Resolves the gated draft open with the id Telegram would have returned. */
  releaseOpen: (draftId: number) => void;
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
 * One fixture, one live draft: a paired owner sends a prompt, the drain opens a
 * plain status bubble, the model's first words open the words draft, and
 * `host.send` blocks so the turn is still live while the Stop updates arrive.
 */
async function liveTurnDraft(options: { gateOpen?: boolean } = {}): Promise<Fixture> {
  const state = await store();
  const secrets = new MemorySecrets();
  const auth = new RemoteAuth(secrets as unknown as vscode.SecretStorage);
  const channel = new FakeRemoteChannel('telegram');

  // Optional gate on the draft open, to model an unpair landing *inside* the
  // await that opens the preview.
  let releaseOpen!: (draftId: number) => void;
  const openGate = new Promise<number>((resolve) => (releaseOpen = resolve));
  let openStarted = false;
  const richDraft: RichDraftTransport = {
    beginDraft: async () => {
      if (!options.gateOpen) return { kind: 'open', draftId: 42 };
      openStarted = true;
      return { kind: 'open', draftId: await openGate };
    },
    updateDraft: async () => undefined,
  };
  channel.richDraft = richDraft;

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
  // The model's first words open the words draft beside the status bubble.
  progressListener?.({ kind: 'commentary', conversationId: 'c1', text: 'Looking at it' });
  if (options.gateOpen) {
    // Parked inside the draft open: the preview does not exist yet.
    await vi.waitFor(() => expect(openStarted).toBe(true), { timeout: 3_000 });
  } else {
    await vi.waitFor(
      () => expect(draftRegistered(controller)).toBe(true),
      { timeout: 3_000 },
    );
  }

  return {
    channel,
    controller,
    auth,
    host,
    sent: host.send,
    cancel,
    release,
    releaseOpen,
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

/** Whether the controller's draft registry holds the words preview yet. */
function draftRegistered(controller: RemoteController): boolean {
  return (controller as unknown as { drafts: { size: number } }).drafts.size > 0;
}

function stopped(draftId: number, providerMessageId: string, overrides = {}): unknown {
  return {
    ...base,
    ...overrides,
    kind: 'generation_stopped',
    draftId,
    providerMessageId,
  };
}

describe('remote generation_stopped (Phase 2 native Stop)', () => {
  it('cancels the conversation that owns the matching live draft', async () => {
    const f = await liveTurnDraft();

    await expect(f.channel.emit(stopped(42, 'stop-1'))).resolves.toEqual({ kind: 'handled' });
    expect(f.cancel).toHaveBeenCalledWith('c1');

    f.release();
    await f.drainDone();
    await f.controller.stop();
  });

  it('ignores a stale or foreign draft id without cancelling anything', async () => {
    const f = await liveTurnDraft();

    // Never opened here: an id from another transport, or from a turn that has
    // already ended. Cancelling on a mismatch would stop a turn the user never
    // pressed Stop on.
    await expect(f.channel.emit(stopped(999, 'stop-999'))).resolves.toEqual({ kind: 'handled' });
    await expect(f.channel.emit(stopped(41, 'stop-41'))).resolves.toEqual({ kind: 'handled' });
    expect(f.cancel).not.toHaveBeenCalled();

    f.release();
    await f.drainDone();
    await f.controller.stop();
  });

  it('ignores a matching draft id in a different chat', async () => {
    const f = await liveTurnDraft();

    // Same owner, same draft id, different chat: the registry key is the pair,
    // so half a match must not cancel. (senderId stays the owner, or this would
    // be an auth rejection rather than a matching test.)
    await expect(f.channel.emit(stopped(42, 'stop-other', { chatId: 'chat-2' }))).resolves.toEqual(
      { kind: 'handled' },
    );
    expect(f.cancel).not.toHaveBeenCalled();

    f.release();
    await f.drainDone();
    await f.controller.stop();
  });

  it('cancels once per draft, so a redelivered Stop cannot cancel twice', async () => {
    const f = await liveTurnDraft();

    await expect(f.channel.emit(stopped(42, 'stop-a'))).resolves.toEqual({ kind: 'handled' });
    // A different provider id, so this is not caught by message-id deduplication:
    // it is the registry entry dropped after the first Stop that answers it.
    await expect(f.channel.emit(stopped(42, 'stop-b'))).resolves.toEqual({ kind: 'handled' });
    expect(f.cancel).toHaveBeenCalledTimes(1);

    f.release();
    await f.drainDone();
    await f.controller.stop();
  });

  it('deduplicates an identical Stop update by its Telegram update id', async () => {
    const f = await liveTurnDraft();

    await expect(f.channel.emit(stopped(42, 'stop-dup'))).resolves.toEqual({ kind: 'handled' });
    const again = await f.channel.emit(stopped(42, 'stop-dup'));
    expect(again.kind === 'rejected' || again.kind === 'handled').toBe(true);
    expect(f.cancel).toHaveBeenCalledTimes(1);

    f.release();
    await f.drainDone();
    await f.controller.stop();
  });

  it('holds a Stop update behind the auth gate', async () => {
    const state = await store();
    const secrets = new MemorySecrets();
    secrets.values.set('forge.remote.telegram.ownerId', 'someone-else');
    const auth = new RemoteAuth(secrets as unknown as vscode.SecretStorage);
    const channel = new FakeRemoteChannel('telegram');
    const cancel = vi.fn();
    const host = {
      createConversation: vi.fn(async () => ({
        id: 'c1',
        title: 'Remote',
        activeModel: 'local',
        archived: false,
      })),
      restoreConversation: vi.fn(),
      send: vi.fn(async () => ({ kind: 'completed' as const, finalText: 'x' })),
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

    // The derived senderId is only a claim; pairing requires a /pair *text*
    // event, so a Stop update cannot establish authority for a chat that has
    // none, and cannot borrow another chat's.
    await expect(
      channel.emit(stopped(42, 'stop-stranger', { senderId: 'stranger' })),
    ).resolves.toMatchObject({ kind: 'rejected', reason: 'sender is not paired' });
    await expect(channel.emit(stopped(42, 'stop-owner'))).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'sender is not paired',
    });
    expect(cancel).not.toHaveBeenCalled();
    await controller.stop();
  });

  it('refuses a Stop update in a group chat', async () => {
    const f = await liveTurnDraft();

    await expect(
      f.channel.emit(stopped(42, 'stop-group', { chatType: 'group' })),
    ).resolves.toMatchObject({ kind: 'rejected', reason: 'private chats only' });
    expect(f.cancel).not.toHaveBeenCalled();

    f.release();
    await f.drainDone();
    await f.controller.stop();
  });

  it('rejects a non-positive draft id as an invalid event', async () => {
    const f = await liveTurnDraft();

    await expect(f.channel.emit(stopped(0, 'stop-zero'))).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'invalid remote event',
    });
    expect(f.cancel).not.toHaveBeenCalled();

    f.release();
    await f.drainDone();
    await f.controller.stop();
  });

  it('cancels an active turn while a question gate is pending, without consuming the Stop', async () => {
    const f = await liveTurnDraft();

    // The live turn is now blocked on ask_user, so the question bridge owns this
    // chat's next plain text. A Stop is a native button update, not text: the
    // question flow must not claim it, or the turn would sit running with the
    // user believing they had stopped it.
    f.askQuestion({
      id: 'q1',
      prompt: 'Which build?',
      options: ['debug', 'release'],
      conversationId: 'c1',
    });
    // Flat choices are offered as Telegram buttons, so the gate reaches the
    // chat as an inline keyboard rather than as plain text.
    await vi.waitFor(() => expect(f.channel.inlineKeyboards).toHaveLength(1));

    await expect(f.channel.emit(stopped(42, 'stop-while-question'))).resolves.toEqual({
      kind: 'handled',
    });
    expect(f.answerQuestion).not.toHaveBeenCalled();
    expect(f.cancel).toHaveBeenCalledWith('c1');

    // The gate is still live afterwards: the Stop cancelled the turn, it did not
    // answer the question, and the chat's next plain text is still the answer.
    await expect(
      f.channel.emit({ ...base, kind: 'text', providerMessageId: 'answer-1', text: 'debug' }),
    ).resolves.toEqual({ kind: 'handled' });
    expect(f.answerQuestion).toHaveBeenCalledWith('q1', 'debug');

    f.release();
    await f.drainDone();
    await f.controller.stop();
  });

  it('reports a Stop whose cancel failed, and still acknowledges the update', async () => {
    const f = await liveTurnDraft();
    // A host whose cancel throws: the turn is still running, and silence would
    // hide that. The controller reads `host.cancel` at call time, so replacing
    // it here is what the real host failing mid-turn looks like.
    f.host.cancel = vi.fn(async () => {
      throw new Error('host busy');
    });

    // Acknowledged, not retried: a Stop the user meant must not loop.
    await expect(f.channel.emit(stopped(42, 'stop-fail'))).resolves.toEqual({
      kind: 'handled',
    });
    // Reported through the controller's onError, with the underlying cause.
    await vi.waitFor(() => expect(f.errors).toHaveLength(1));
    expect(f.errors[0]).toContain('could not cancel the turn');
    expect(f.errors[0]).toContain('host busy');

    f.release();
    await f.drainDone();
    await f.controller.stop();
  });

  it('settles a pending approval keyboard when a Stop cancels the turn (Phase 1 x Phase 2)', async () => {
    const f = await liveTurnDraft();

    // The cross-phase seam: a turn blocked on a tool-approval gate, then
    // stopped with the native button. AgentLoop.cancel settles the approval as
    // cancelled, and Phase 1's contract is that the Approve/Deny keyboard is
    // greyed out rather than deleted — otherwise the chat keeps two live
    // buttons for a gate that no longer exists, and tapping one later is the
    // stale-callback path.
    f.askApproval({
      id: 'confirm-1',
      toolName: 'exec_command',
      detail: 'run a build',
      dangerous: false,
      conversationId: 'c1',
    });
    // An approval gate is delivered as a `send` carrying a correlationId; the
    // Telegram transport attaches the Approve/Deny keyboard itself, so the fake
    // channel records the prompt under `sent`, not `inlineKeyboards`.
    await vi.waitFor(() =>
      expect(f.channel.sent.some((m) => m.text.startsWith('Forge approval'))).toBe(true),
    );

    await expect(f.channel.emit(stopped(42, 'stop-during-approval'))).resolves.toEqual({
      kind: 'handled',
    });
    expect(f.cancel).toHaveBeenCalledWith('c1');

    // Phase 1's disabled-button path, not a retraction: the keyboard message is
    // resolved as denied, and the outcome sentence names the reason the host
    // settled it — 'cancelled', not 'resolved'.
    await vi.waitFor(() => expect(f.channel.resolvedKeyboards).toHaveLength(1));
    expect(f.channel.resolvedKeyboards[0]).toMatchObject({ chatId: 'chat-1', approved: false });
    // The keyboard message it greyed out is the one the approval prompt sent.
    const prompt = f.channel.sent.find((m) => m.text.startsWith('Forge approval'))!;
    expect(f.channel.resolvedKeyboards[0]?.keyboardMessageIds).toEqual([
      ...(prompt ? [`sent-${f.channel.sent.indexOf(prompt) + 1}`] : []),
    ]);
    expect(f.channel.clearedKeyboards).toEqual([]);
    await vi.waitFor(() =>
      expect(f.channel.sent.map((m) => m.text)).toContain('Forge approval denied (cancelled).'),
    );

    f.release();
    await f.drainDone();
    await f.controller.stop();
  });

  it('leaves no claimable draft once the channel has been forgotten', async () => {
    const f = await liveTurnDraft();

    // `forgetChannel` is what RemoteRuntime.unpair calls on the controller. It
    // clears held prompts, and must clear live drafts too: the preview is
    // Telegram-side and lasts ~30s, so a Stop can outlive the unpair, and the
    // previous owner's conversation must not be cancellable afterwards.
    //
    // Auth is deliberately left intact here, so the auth gate still passes on
    // the Stop below — the only thing that can make it cancel is a leftover
    // registry entry, which is the hole this wiring closes.
    f.controller.forgetChannel('telegram');

    await expect(f.channel.emit(stopped(42, 'stop-after-forget'))).resolves.toEqual({
      kind: 'handled',
    });
    expect(f.cancel).not.toHaveBeenCalled();

    f.release();
    await f.drainDone();
    await f.controller.stop();
  });

  it('reports cancellation by editing the status bubble, separate from the answer', async () => {
    const f = await liveTurnDraft();

    await f.channel.emit(stopped(42, 'stop-1'));
    f.release();
    await f.drainDone();

    // The status is the plain bubble, edited in place; the words preview
    // carries no status and simply expires on Telegram's side.
    expect(f.channel.progress).toEqual([{ chatId: 'chat-1', text: 'Forge: working…' }]);
    // The answer/notification travels its own path, not the status message.
    expect(f.channel.sent.map((m) => m.text)).not.toContain('Forge: cancelled.');
    await f.controller.stop();
  });

  it('cannot be cancelled through a draft that opened during an unpair, after re-pairing', async () => {
    // The deferred-open race, end to end. The words preview is parked inside
    // its open when the owner unpairs; the open then returns an id *after* the
    // registry was cleared. Registering it would hand a live preview to the next
    // pairing of the same chat, so a Stop pressed on the old preview would cancel
    // a turn the new owner never opened. `forgetChannel` alone cannot close this:
    // it runs before the id exists.
    const f = await liveTurnDraft({ gateOpen: true });

    // Exactly what RemoteRuntime.unpair does.
    await f.auth.unpair('telegram');
    f.controller.forgetChannel('telegram');

    // The preview lands after the revocation.
    f.releaseOpen(42);
    await vi.waitFor(() => expect(f.sent).toHaveBeenCalled());

    // Re-pair the same private chat: a different pairing, same sender id, so the
    // ordinary auth gate on the Stop below still passes — only the registry can
    // decide this one.
    const code = f.auth.beginPairing('telegram');
    await f.channel.emit({ ...base, kind: 'text', providerMessageId: 're-pair', text: `/pair ${code}` });

    await expect(f.channel.emit(stopped(42, 'stop-stale-draft'))).resolves.toEqual({
      kind: 'handled',
    });
    // The assertion that matters, and the one that fails without the epoch
    // guard: the Stop resolved to nothing.
    expect(f.cancel).not.toHaveBeenCalled();

    f.release();
    await f.drainDone();
    await f.controller.stop();
  });
});

/**
 * The ⏹ Stop under the status bubble, which replaced the native Stop above.
 * The tap names the bubble's message id, and only the turn that owns that
 * bubble may be cancelled.
 */
describe('remote stop_action (status bubble Stop button)', () => {
  function bubbleId(channel: FakeRemoteChannel): string {
    const index = channel.progress.findIndex((p) => p.text.startsWith('Forge: working'));
    expect(index).toBeGreaterThanOrEqual(0);
    return String(index + 1);
  }

  function tap(messageId: string, providerMessageId: string, overrides = {}): unknown {
    return { ...base, ...overrides, kind: 'stop_action', messageId, providerMessageId };
  }

  it('shows the button for the turn, cancels it on a tap, and drops it at the end', async () => {
    const f = await liveTurnDraft();
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
    const f = await liveTurnDraft();
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
    const f = await liveTurnDraft();
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
