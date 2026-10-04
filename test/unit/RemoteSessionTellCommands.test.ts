import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { handleRemoteCommand } from '../../src/remote/RemoteCommandHandler';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteAuth } from '../../src/remote/RemoteAuth';
import { RemoteController } from '../../src/remote/RemoteController';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import { setMeshOrchestrator } from '../../src/agentMesh/meshContext';
import type { MeshOrchestrator } from '../../src/agentMesh/meshOrchestrator';
import type { RemoteInboundEvent } from '../../src/remote/types';

/** In-memory SecretStorage, same shape the other remote tests use. */
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

/**
 * Phase 5: `/claude`, `/codex`, `/copilot` — a one-way note from a remote chat
 * into a live session's FIFO.
 *
 * The invariants that matter here are about what the user is TOLD and what
 * happens on a failure, because the mesh has already taken the message by the
 * time the transport is involved:
 *
 * - The acknowledgement says "accepted". Never "started" or "delivered": the
 *   mesh has queued the note, and nothing proves it has run.
 * - A failed acknowledgement must not throw. `handleRemoteCommand` turns a
 *   throw into a discarded control receipt and a `retry`, the poll loop
 *   redelivers the update, and the same note is enqueued a second time.
 * - The control-event receipt is what stops a redelivered Telegram update from
 *   enqueueing the same text twice, and an `unknown` receipt must refuse rather
 *   than guess.
 */

const tempDirs: string[] = [];

async function store(): Promise<RemoteRequestStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-tell-test-'));
  tempDirs.push(directory);
  const result = new RemoteRequestStore(path.join(directory, 'state.json'));
  await result.load();
  return result;
}

/** The tell calls the fake orchestrator recorded. */
interface TellCall {
  alias: string;
  message: string;
  expectsReply: boolean | undefined;
}

function fakeOrchestrator(
  tell: MeshOrchestrator['tell'],
): { orchestrator: MeshOrchestrator; calls: TellCall[] } {
  const calls: TellCall[] = [];
  const orchestrator = {
    tell: async (alias: string, message: string, options = {}) => {
      calls.push({ alias, message, expectsReply: options.expectsReply });
      return tell(alias, message, options);
    },
  } as unknown as MeshOrchestrator;
  return { orchestrator, calls };
}

function textEvent(text: string): RemoteInboundEvent {
  return {
    channel: 'fake',
    kind: 'text',
    providerMessageId: `msg-${text.slice(1, 7)}`,
    senderId: 'owner',
    chatId: 'chat-a',
    chatType: 'private',
    receivedAt: 1,
    text,
  } as RemoteInboundEvent;
}

async function fixture(
  orchestrator: MeshOrchestrator | undefined,
  options: { sendError?: string; onError?: (message: string) => void } = {},
) {
  const state = await store();
  const channel = new FakeRemoteChannel();
  if (options.sendError) channel.sendError = options.sendError;
  const onError = options.onError ?? vi.fn();
  const context = {
    channel,
    store: state,
    host: {},
    workspaceId: 'workspace',
    signal: new AbortController().signal,
    inactivityTimeoutMinutes: 30,
    rateLimitPerMinute: 30,
    modelEntries: [],
    workspaceAliases: {},
    onError,
  };
  return { state, channel, context: context as never, onError };
}

describe('remote session tell commands (Phase 5)', () => {
  beforeEach(() => setMeshOrchestrator(undefined));
  afterEach(async () => {
    setMeshOrchestrator(undefined);
    for (const directory of tempDirs.splice(0))
      await fs.rm(directory, { recursive: true, force: true });
  });

  /** The three commands map to the three aliases, whole remainder included. */
  it('routes /claude, /codex and /copilot to their aliases with the whole remainder', async () => {
    const { orchestrator, calls } = fakeOrchestrator(async () => ({
      exchangeId: 'ex-1',
      to: 'x',
      observing: false,
    }));
    setMeshOrchestrator(orchestrator);
    const { context, channel } = await fixture(orchestrator);

    await expect(
      handleRemoteCommand(textEvent('/claude build 2 failed on linux'), context, 'd1'),
    ).resolves.toEqual({ kind: 'handled' });
    await expect(handleRemoteCommand(textEvent('/codex still broken'), context, 'd2')).resolves.toEqual(
      { kind: 'handled' },
    );
    await expect(
      handleRemoteCommand(textEvent('/copilot  look at this  '), context, 'd3'),
    ).resolves.toEqual({ kind: 'handled' });

    expect(calls).toEqual([
      { alias: 'claude', message: 'build 2 failed on linux', expectsReply: false },
      { alias: 'codex', message: 'still broken', expectsReply: false },
      { alias: 'copilot', message: 'look at this', expectsReply: false },
    ]);
    // One acknowledgement per command, and none of them echoes the note back:
    // the user just typed it, and a Telegram echo of a long note costs a chunk.
    expect(channel.sent).toHaveLength(3);
    expect(channel.sent[0]!.text).toContain('claude');
    expect(channel.sent[0]!.text).toContain('exchange ex-1');
    expect(channel.sent.map((message) => message.text).join('\n')).not.toContain('linux');
  });

  /** A bare token is this command's, so it gets its own usage line. */
  it('rejects an empty message with the usage line and enqueues nothing', async () => {
    const { orchestrator, calls } = fakeOrchestrator(async () => ({
      exchangeId: 'ex-2',
      to: 'claude',
      observing: false,
    }));
    setMeshOrchestrator(orchestrator);
    const { context, channel } = await fixture(orchestrator);

    await expect(handleRemoteCommand(textEvent('/claude'), context, 'd4')).resolves.toEqual({
      kind: 'rejected',
      reason: 'usage: /claude <message>',
    });
    await expect(handleRemoteCommand(textEvent('/codex    '), context, 'd5')).resolves.toEqual({
      kind: 'rejected',
      reason: 'usage: /codex <message>',
    });
    expect(calls).toEqual([]);
    expect(channel.sent).toEqual([]);
  });

  /** The single gate: no orchestrator means no mesh, for either cause. */
  it('rejects when the agent mesh is not up in this window', async () => {
    const { context, channel } = await fixture(undefined);
    await expect(handleRemoteCommand(textEvent('/claude hello'), context, 'd6')).resolves.toEqual({
      kind: 'rejected',
      reason: 'the agent mesh is not up in this window',
    });
    expect(channel.sent).toEqual([]);
  });

  /** The mesh's own reason is surfaced verbatim as a rejection. */
  it('surfaces a tell error as a rejection, not a success', async () => {
    const { orchestrator } = fakeOrchestrator(async (alias) => ({
      error: `no live session for "${alias}" (no alias, no live pin, no owned session)`,
    }));
    setMeshOrchestrator(orchestrator);
    const { context, channel } = await fixture(orchestrator);

    await expect(
      handleRemoteCommand(textEvent('/codex are you there'), context, 'd7'),
    ).resolves.toEqual({
      kind: 'rejected',
      reason: 'no live session for "codex" (no alias, no live pin, no owned session)',
    });
    expect(channel.sent).toEqual([]);
  });

  /**
   * `observing` describes session ownership, not proof of execution, so the
   * acknowledgement must not read as "started" even for an owned session.
   */
  it('says accepted, never started or delivered, for an owned session', async () => {
    const { orchestrator } = fakeOrchestrator(async () => ({
      exchangeId: 'ex-3',
      to: 'claude',
      observing: true,
    }));
    setMeshOrchestrator(orchestrator);
    const { context, channel } = await fixture(orchestrator);

    await expect(handleRemoteCommand(textEvent('/claude go'), context, 'd8')).resolves.toEqual({
      kind: 'handled',
    });
    const text = channel.sent[0]!.text;
    expect(text).toContain('accepted');
    expect(text).toContain('exchange ex-3');
    expect(text).not.toMatch(/started|delivered|finished|answered/iu);
    expect(text).toContain('not a question');
  });

  /**
   * THE failure that matters: the note is durably queued, then the
   * acknowledgement send fails. Throwing here would discard the control receipt
   * and the redelivered update would enqueue the same note a second time.
   */
  it('keeps the command completed when the acknowledgement send fails', async () => {
    const { orchestrator, calls } = fakeOrchestrator(async () => ({
      exchangeId: 'ex-4',
      to: 'claude',
      observing: false,
    }));
    setMeshOrchestrator(orchestrator);
    const onError = vi.fn();
    const { context, channel, state } = await fixture(orchestrator, {
      sendError: 'telegram transport is down',
      onError,
    });

    await expect(
      handleRemoteCommand(textEvent('/claude ship it'), context, 'd9'),
    ).resolves.toEqual({ kind: 'handled' });
    expect(calls).toHaveLength(1);
    expect(channel.sent).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0]![0])).toContain('telegram transport is down');
    // The receipt is completed, so the redelivered update cannot re-enqueue.
    await expect(handleRemoteCommand(textEvent('/claude ship it'), context, 'd9')).resolves.toEqual(
      { kind: 'handled' },
    );
    expect(calls).toHaveLength(1);
    expect(await state.beginControlEvent('d9')).toBe('completed');
  });

  it('keeps the receipt completed if reporting the failed acknowledgement also throws', async () => {
    const { orchestrator, calls } = fakeOrchestrator(async () => ({
      exchangeId: 'ex-log-failure',
      to: 'claude',
      observing: false,
    }));
    setMeshOrchestrator(orchestrator);
    const { context, state } = await fixture(orchestrator, {
      sendError: 'telegram transport is down',
      onError: () => {
        throw new Error('logger failed');
      },
    });
    const fallbackLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(handleRemoteCommand(textEvent('/claude once'), context, 'log-failure')).resolves.toEqual({ kind: 'handled' });
      expect(await state.beginControlEvent('log-failure')).toBe('completed');
      expect(calls).toHaveLength(1);
      expect(fallbackLog).toHaveBeenCalledOnce();
    } finally {
      fallbackLog.mockRestore();
    }
  });

  /** A replayed Telegram update must not enqueue the same text twice. */
  it('does not enqueue again for a duplicate control event', async () => {
    const { orchestrator, calls } = fakeOrchestrator(async () => ({
      exchangeId: 'ex-5',
      to: 'claude',
      observing: false,
    }));
    setMeshOrchestrator(orchestrator);
    const { context, channel } = await fixture(orchestrator);

    await expect(handleRemoteCommand(textEvent('/claude once'), context, 'dup')).resolves.toEqual({
      kind: 'handled',
    });
    await expect(handleRemoteCommand(textEvent('/claude once'), context, 'dup')).resolves.toEqual({
      kind: 'handled',
    });
    expect(calls).toHaveLength(1);
    expect(channel.sent).toHaveLength(1);
  });

  /**
   * Crash between mesh acceptance and receipt completion: the receipt is
   * `unknown`, and Forge must refuse rather than blindly send the note again.
   */
  it('refuses a replay whose control outcome is unknown', async () => {
    const { orchestrator, calls } = fakeOrchestrator(async () => ({
      exchangeId: 'ex-6',
      to: 'claude',
      observing: false,
    }));
    setMeshOrchestrator(orchestrator);
    const { context, state } = await fixture(orchestrator);

    // Model the crash: the receipt was written pending and never finished.
    expect(await state.beginControlEvent('crashed')).toBe('admitted');
    await expect(
      handleRemoteCommand(textEvent('/claude do not double'), context, 'crashed'),
    ).resolves.toEqual({
      kind: 'rejected',
      reason: 'previous command outcome is unknown; resend it',
    });
    expect(calls).toEqual([]);
  });

  /** The same ceiling as `tell_live_session`, refused before the mesh is called. */
  it('refuses a note over the mesh message limit', async () => {
    const { orchestrator, calls } = fakeOrchestrator(async () => ({
      exchangeId: 'ex-7',
      to: 'claude',
      observing: false,
    }));
    setMeshOrchestrator(orchestrator);
    const { context } = await fixture(orchestrator);
    const tooLong = 'x'.repeat(4001);

    await expect(
      handleRemoteCommand(textEvent(`/claude ${tooLong}`), context, 'd10'),
    ).resolves.toEqual({
      kind: 'rejected',
      reason: '/claude message is 4001 chars; the limit is 4000.',
    });
    // Refused before the mesh was asked — nothing was queued.
    expect(calls).toEqual([]);

    // Exactly at the ceiling is accepted: the limit is 4000, not 3999.
    const atLimit = 'y'.repeat(4000);
    await expect(
      handleRemoteCommand(textEvent(`/claude ${atLimit}`), context, 'd10b'),
    ).resolves.toEqual({ kind: 'handled' });
    expect(calls).toEqual([{ alias: 'claude', message: atLimit, expectsReply: false }]);
  });

  /**
   * Prefix safety: `/claudeai` and `/codexy` are not aliases, and must not be
   * captured by the tell branch. They fall through to the generic unknown
   * command, which is what proves the match is exact rather than a startsWith.
   */
  it('leaves unrelated commands to the rest of the chain', async () => {
    const { orchestrator, calls } = fakeOrchestrator(async () => ({
      exchangeId: 'ex-8',
      to: 'claude',
      observing: false,
    }));
    setMeshOrchestrator(orchestrator);
    const { context } = await fixture(orchestrator);
    for (const text of ['/claudeai hi', '/codexy hi', '/copilotx hi']) {
      await expect(handleRemoteCommand(textEvent(text), context, `d12-${text}`)).resolves.toEqual({
        kind: 'rejected',
        reason: 'unknown command',
      });
    }
    expect(calls).toEqual([]);
  });

  /**
   * The security edge: a tell injects a prompt into someone else's live
   * session, so an unpaired sender must never reach it. Tested through the real
   * controller rather than assumed — the auth gate lives in
   * `RemoteController.handle`, upstream of the command dispatch this file
   * otherwise exercises directly.
   */
  it('holds a session tell behind the owner auth gate', async () => {
    const { orchestrator, calls } = fakeOrchestrator(async () => ({
      exchangeId: 'ex-9',
      to: 'claude',
      observing: false,
    }));
    setMeshOrchestrator(orchestrator);

    const state = await store();
    const secrets = new MemorySecrets();
    secrets.values.set('forge.remote.fake.ownerId', 'someone-else');
    const auth = new RemoteAuth(secrets as unknown as vscode.SecretStorage);
    const channel = new FakeRemoteChannel();
    const host = {
      createConversation: vi.fn(async () => ({ id: 'c1', title: 'Remote' })),
      restoreConversation: vi.fn(),
      send: vi.fn(async () => ({ kind: 'completed' as const, finalText: 'x' })),
      cancel: vi.fn(),
      addApprovalSink: () => ({ dispose: () => undefined }),
      addQuestionSink: () => ({ dispose: () => undefined }),
      answerQuestion: () => false,
      status: () => ({
        activeConversationId: 'c1',
        conversations: [],
        requestChains: [],
        streamingConversationIds: [],
      }),
    } as never;
    const controller = new RemoteController(channel, state, auth, host, {
      workspaceId: 'workspace',
      queueLimit: 5,
      maxMessageChars: 12_000,
      rateLimitPerMinute: 30,
    });
    await controller.start();
    try {
      await expect(
        channel.emit({
          channel: 'fake',
          kind: 'text',
          providerMessageId: 'stranger-tell',
          senderId: 'stranger',
          chatId: 'private-chat',
          chatType: 'private',
          receivedAt: Date.now(),
          text: '/claude do something',
        } as RemoteInboundEvent),
      ).resolves.toMatchObject({ kind: 'rejected', reason: 'sender is not paired' });
      // Nothing reached the mesh: the refusal is the whole response.
      expect(calls).toEqual([]);
    } finally {
      await controller.stop();
    }
  });
});
