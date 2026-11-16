/**
 * The busy-switch safety gate: `/workspace <n>` while something is running
 * refuses with what is running, says what the switch will stop, and waits for
 * an answer before it reloads the window. Phase 1 of
 * `docs/plans/TELEGRAM_WORKSPACE_SWITCH_SAFETY_PLAN.md` refused with two
 * buttons because `new-window` did not exist yet and a dead button is a bug;
 * phase 2 adds it, and the two modes are judged by what each one actually
 * destroys — a reload stops everything in the window, a new window stops only
 * the transports.
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import {
  handleRemoteCommand,
  type RemoteCommandContext,
} from '../../src/remote/RemoteCommandHandler';
import { handleRemoteSelectionAction } from '../../src/remote/RemoteSelectionPager';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import {
  clearPendingWorkspaceConfirms,
  pendingWorkspaceAlias,
} from '../../src/remote/remoteWorkspaceCommand';
import type { RemoteInboundEvent, WorkspaceSwitchModeChoice } from '../../src/remote/types';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';

const tempDirs: string[] = [];

afterEach(async () => {
  clearPendingWorkspaceConfirms();
  for (const directory of tempDirs.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function requestStore(): Promise<RemoteRequestStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-workspace-switch-'));
  tempDirs.push(directory);
  const store = new RemoteRequestStore(path.join(directory, 'state.json'));
  await store.load();
  return store;
}

function textEvent(text: string): Extract<RemoteInboundEvent, { kind: 'text' }> {
  return {
    channel: 'fake',
    kind: 'text',
    providerMessageId: `message-${text}`,
    senderId: 'owner',
    chatId: 'chat',
    chatType: 'private',
    receivedAt: 1,
    text,
  };
}

function selectionEvent(
  choice: number,
  token: string,
  messageId: string,
): Extract<RemoteInboundEvent, { kind: 'selection' }> {
  return {
    channel: 'fake',
    kind: 'selection',
    providerMessageId: `callback-${messageId}`,
    senderId: 'owner',
    chatId: 'chat',
    chatType: 'private',
    receivedAt: 1,
    messageId,
    selectionKind: 'workspaces',
    selectionToken: token,
    action: 'select',
    choice,
  };
}

/** A window with `strata` answering, the state `/workspace` must refuse for. */
function busyHost(): ForgeHostFacade {
  return {
    status: () => ({
      conversations: [{ id: 'c1', title: 'Answering', activeModel: 'strata', archived: false }],
      requestChains: [{ conversationId: 'c1' }],
      streamingConversationIds: ['c1'],
      pendingApproval: undefined,
    }),
  } as unknown as ForgeHostFacade;
}

function idleHost(): ForgeHostFacade {
  return {
    status: () => ({
      conversations: [],
      requestChains: [],
      streamingConversationIds: [],
      pendingApproval: undefined,
    }),
  } as unknown as ForgeHostFacade;
}

const aliases = { forge: 'Forge', halluscribe: 'Halluscribe' };

function commandContext(
  channel: FakeRemoteChannel,
  store: RemoteRequestStore,
  host: ForgeHostFacade,
  switched: string[],
  /** Which mode the switch was actually run in — the phase 2 half of the
   *  invariant is not just that it moved, but that it moved the way the owner
   *  answered. */
  modes?: WorkspaceSwitchModeChoice[],
): RemoteCommandContext {
  return {
    channel,
    store,
    host,
    workspaceId: 'ws-forge',
    signal: new AbortController().signal,
    inactivityTimeoutMinutes: 30,
    rateLimitPerMinute: 30,
    modelEntries: [],
    workspaceAliases: aliases,
    currentWorkspaceAlias: 'forge',
    currentWorkspaceName: 'Forge',
    switchWorkspace: async (alias, _channel, _chatId, mode) => {
      switched.push(alias);
      modes?.push(mode);
      return async () => undefined;
    },
  };
}

describe('/workspace while Forge is busy', () => {
  it('refuses, names the running model, and arms a confirmation', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const switched: string[] = [];
    const ctx = commandContext(channel, store, busyHost(), switched);

    await expect(
      handleRemoteCommand(textEvent('/workspace halluscribe'), ctx, 'ws-busy'),
    ).resolves.toMatchObject({ kind: 'handled' });

    // Nothing switched: the whole point is that a busy window is not reloaded
    // on the strength of a command that was asked before the warning existed.
    expect(switched).toEqual([]);
    const keyboard = channel.selectionChoiceSends[0];
    expect(keyboard?.text).toContain('strata is answering');
    // The consequence the owner cannot see from the button alone: the lease is
    // per channel, so every other chat bound here is refused after the move.
    expect(keyboard?.text).toContain('whole Forge connection');
    expect(keyboard?.text).toContain('refused until someone switches back');
    // Phase 2's third choice: the owner is offered the move that does not
    // destroy the window they are looking at.
    expect(keyboard?.choices.map((choice) => choice.value)).toEqual([0, 1, 2]);
    expect(keyboard?.choices[1]?.label).toContain('new window');
    expect(keyboard?.text).toContain('keeps this window open');
    expect(keyboard?.controls.kind).toBe('workspaces');
    expect(pendingWorkspaceAlias('fake', 'chat')).toEqual({ alias: 'halluscribe' });
  });

  /**
   * Phase 2c, from the owner's own run on 2026-10-30: they picked a workspace
   * from the `/workspace` list while nothing was running, and the switch ran in
   * `replace` at once — the new-window choice that would have kept their window
   * open was never shown. An idle window is now asked the same question a busy
   * one is; only a mode typed by hand runs without being asked.
   */
  it('an idle window asks which move instead of reloading at once', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const switched: string[] = [];
    const ctx = commandContext(channel, store, idleHost(), switched);

    await expect(
      handleRemoteCommand(textEvent('/workspace halluscribe'), ctx, 'ws-idle'),
    ).resolves.toMatchObject({ kind: 'handled' });
    // Nothing moved, and nothing was promised: the keyboard is the answer, and
    // it is the same three-button keyboard a busy window gets.
    expect(switched).toEqual([]);
    expect(channel.sent.some((message) => message.text.includes('switching to'))).toBe(false);
    const keyboard = channel.selectionChoiceSends[0];
    expect(keyboard?.text).toContain('Nothing is running here');
    expect(keyboard?.text).toContain('open Halluscribe in a new window and keep this one');
    expect(keyboard?.choices.map((choice) => choice.value)).toEqual([0, 1, 2]);
    expect(keyboard?.choices[0]?.label).toContain('reloads it');
    expect(keyboard?.text).toContain('keeps this window open');
    expect(keyboard?.controls.kind).toBe('workspaces');
    expect(pendingWorkspaceAlias('fake', 'chat')).toEqual({ alias: 'halluscribe' });
  });

  /** The idle keyboard has to be answerable, not decoration: a tap on the new
   *  choice moves in new-window mode, and a tap on replace moves in replace. */
  it('an idle tap on new-window moves in new-window mode', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const switched: string[] = [];
    const modes: WorkspaceSwitchModeChoice[] = [];
    const ctx = commandContext(channel, store, idleHost(), switched, modes);

    await handleRemoteCommand(textEvent('/workspace halluscribe'), ctx, 'ws-idle-ask');
    const token = channel.selectionChoiceSends[0]!.controls.token;
    const selectionContext = {
      channel,
      store,
      host: idleHost(),
      signal: new AbortController().signal,
      workspaceId: 'ws-forge',
      modelEntries: [],
      workspaceAliases: aliases,
      currentWorkspaceAlias: 'forge',
      currentWorkspaceName: 'Forge',
      switchWorkspace: ctx.switchWorkspace,
    };

    await expect(
      handleRemoteSelectionAction(selectionEvent(1, token, 'tap-new'), selectionContext, 'tap-new'),
    ).resolves.toMatchObject({ kind: 'handled' });
    expect(switched).toEqual(['halluscribe']);
    expect(modes).toEqual(['new-window']);
    expect(channel.sent.at(-1)?.text).toContain('opening Halluscribe in a new window');
    // The keyboard goes with the answer, so a redelivered tap is refused rather
    // than starting a second handoff — the same invariant the busy keyboard has.
    expect(store.selection('fake', 'chat', 'workspaces')).toBeUndefined();
    expect(pendingWorkspaceAlias('fake', 'chat')).toBeUndefined();
  });

  it('an idle tap on replace moves in replace mode', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const switched: string[] = [];
    const modes: WorkspaceSwitchModeChoice[] = [];
    const ctx = commandContext(channel, store, idleHost(), switched, modes);

    await handleRemoteCommand(textEvent('/workspace halluscribe'), ctx, 'ws-idle-ask');
    const token = channel.selectionChoiceSends[0]!.controls.token;
    const selectionContext = {
      channel,
      store,
      host: idleHost(),
      signal: new AbortController().signal,
      workspaceId: 'ws-forge',
      modelEntries: [],
      workspaceAliases: aliases,
      currentWorkspaceAlias: 'forge',
      currentWorkspaceName: 'Forge',
      switchWorkspace: ctx.switchWorkspace,
    };

    await expect(
      handleRemoteSelectionAction(
        selectionEvent(0, token, 'tap-replace'),
        selectionContext,
        'tap-replace',
      ),
    ).resolves.toMatchObject({ kind: 'handled' });
    expect(switched).toEqual(['halluscribe']);
    expect(modes).toEqual(['replace']);
    expect(channel.sent.at(-1)?.text).toContain('switching to Halluscribe');
  });

  /** A mode typed by hand is an answer already: it runs at once when that
   *  mode's own gate is clear, and no keyboard is put on screen to be answered. */
  it('a mode typed by hand runs at once when nothing is running, with no keyboard', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const switched: string[] = [];
    const modes: WorkspaceSwitchModeChoice[] = [];
    const ctx = commandContext(channel, store, idleHost(), switched, modes);

    await expect(
      handleRemoteCommand(textEvent('/workspace halluscribe new-window'), ctx, 'ws-idle-typed'),
    ).resolves.toMatchObject({ kind: 'handled' });
    expect(switched).toEqual(['halluscribe']);
    expect(modes).toEqual(['new-window']);
    expect(channel.selectionChoiceSends).toHaveLength(0);
    expect(pendingWorkspaceAlias('fake', 'chat')).toBeUndefined();
  });

  /** The idle keyboard arms the **same** in-process confirmation a busy one
   *  does, so a window reload between the question and the answer cannot move
   *  the chat blind — the case the busy keyboard already proves, now proven for
   *  the idle path too. */
  it('an idle tap after a window reload cannot switch', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const switched: string[] = [];
    const ctx = commandContext(channel, store, idleHost(), switched);

    await handleRemoteCommand(textEvent('/workspace halluscribe'), ctx, 'ws-idle-ask');
    const token = channel.selectionChoiceSends[0]!.controls.token;
    // The confirmation lives in memory, so a reload drops it: a tap on the old
    // keyboard is refused rather than moving the chat with no warning behind
    // it.
    clearPendingWorkspaceConfirms();
    const late = await handleRemoteSelectionAction(
      selectionEvent(0, token, 'tap-late'),
      {
        channel,
        store,
        host: idleHost(),
        signal: new AbortController().signal,
        workspaceId: 'ws-forge',
        modelEntries: [],
        workspaceAliases: aliases,
        switchWorkspace: ctx.switchWorkspace,
      },
      'tap-late',
    );
    expect(late).toMatchObject({ kind: 'rejected' });
    expect((late as { reason: string }).reason).toContain('nothing to confirm');
    expect(switched).toEqual([]);
  });

  it('a pending approval blocks a reload even with nothing streaming', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const switched: string[] = [];
    const host = {
      status: () => ({
        conversations: [],
        requestChains: [],
        streamingConversationIds: [],
        pendingApproval: { id: 'a1' },
      }),
    } as unknown as ForgeHostFacade;
    const ctx = commandContext(channel, store, host, switched);

    await handleRemoteCommand(textEvent('/workspace halluscribe'), ctx, 'ws-approval');
    // A reload orphans an approval just as surely as it stops a generation, so
    // the global check — not just this chat's state — is what `replace` uses.
    expect(switched).toEqual([]);
    expect(channel.selectionChoiceSends[0]?.text).toContain('tool approval is waiting');
  });

  it('runs the switch once when the confirmation is answered by text', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const switched: string[] = [];
    const ctx = commandContext(channel, store, busyHost(), switched);

    await handleRemoteCommand(textEvent('/workspace halluscribe'), ctx, 'ws-ask');
    await expect(
      handleRemoteCommand(textEvent('/workspace halluscribe replace'), ctx, 'ws-yes'),
    ).resolves.toMatchObject({ kind: 'handled' });
    expect(switched).toEqual(['halluscribe']);

    // The confirmation is consumed, so a redelivered or repeated answer cannot
    // start a second handoff — and it re-asks rather than switching blind.
    await handleRemoteCommand(textEvent('/workspace halluscribe replace'), ctx, 'ws-yes-again');
    expect(switched).toEqual(['halluscribe']);
    expect(channel.sent.at(-1)?.text).toContain('switching to Halluscribe');
  });

  it('answers the same confirmation for the retained /new alias', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const switched: string[] = [];
    const ctx = commandContext(channel, store, busyHost(), switched);

    // `/new <n>` is the silent alias of `/workspace <n>`, so it has to carry the
    // verb too. The handler read only the first operand there, so `/new
    // halluscribe replace` re-asked and the switch never ran.
    await handleRemoteCommand(textEvent('/new halluscribe'), ctx, 'new-ask');
    await expect(
      handleRemoteCommand(textEvent('/new halluscribe replace'), ctx, 'new-yes'),
    ).resolves.toMatchObject({ kind: 'handled' });
    expect(switched).toEqual(['halluscribe']);
  });

  it('refuses a cold `replace` until the warning has been sent', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const switched: string[] = [];
    const ctx = commandContext(channel, store, busyHost(), switched);

    // No prior refusal: the verb alone must not skip the warning, the way
    // `/sleep confirm` cannot confirm a sleep nobody asked for.
    await handleRemoteCommand(textEvent('/workspace halluscribe replace'), ctx, 'ws-cold');
    expect(switched).toEqual([]);
    expect(channel.selectionChoiceSends[0]?.text).toContain('nothing to confirm');
    expect(pendingWorkspaceAlias('fake', 'chat')).toEqual({ alias: 'halluscribe' });
  });

  it('cancel drops the confirmation and switches nothing', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const switched: string[] = [];
    const ctx = commandContext(channel, store, busyHost(), switched);

    await handleRemoteCommand(textEvent('/workspace halluscribe'), ctx, 'ws-ask');
    await handleRemoteCommand(textEvent('/workspace halluscribe cancel'), ctx, 'ws-no');
    expect(switched).toEqual([]);
    expect(channel.sent.at(-1)?.text).toContain('not switching');
    expect(pendingWorkspaceAlias('fake', 'chat')).toBeUndefined();
  });

  it('runs the switch from the tapped choice, and only once', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const switched: string[] = [];
    const ctx = commandContext(channel, store, busyHost(), switched);

    await handleRemoteCommand(textEvent('/workspace halluscribe'), ctx, 'ws-ask');
    const token = channel.selectionChoiceSends[0]!.controls.token;
    const selectionContext = {
      channel,
      store,
      host: busyHost(),
      signal: new AbortController().signal,
      workspaceId: 'ws-forge',
      modelEntries: [],
      workspaceAliases: aliases,
      currentWorkspaceAlias: 'forge',
      currentWorkspaceName: 'Forge',
      switchWorkspace: ctx.switchWorkspace,
    };

    await expect(
      handleRemoteSelectionAction(selectionEvent(0, token, 'tap1'), selectionContext, 'tap-1'),
    ).resolves.toMatchObject({ kind: 'handled' });
    expect(switched).toEqual(['halluscribe']);

    // Telegram redelivers callbacks: the second tap must not begin a second
    // move. It is refused because answering a choice keyboard clears it, so the
    // redelivered tap finds no live choice — and the switch count is the real
    // invariant here, one handoff from one confirmation.
    const again = await handleRemoteSelectionAction(
      selectionEvent(0, token, 'tap2'),
      selectionContext,
      'tap-2',
    );
    expect(again).toMatchObject({ kind: 'rejected' });
    expect((again as { reason: string }).reason).toContain('expired');
    expect(switched).toEqual(['halluscribe']);
  });

  it('a tapped cancel answers the keyboard without moving the chat', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const switched: string[] = [];
    const ctx = commandContext(channel, store, busyHost(), switched);

    await handleRemoteCommand(textEvent('/workspace halluscribe'), ctx, 'ws-ask');
    const token = channel.selectionChoiceSends[0]!.controls.token;
    const selectionContext = {
      channel,
      store,
      host: busyHost(),
      signal: new AbortController().signal,
      workspaceId: 'ws-forge',
      modelEntries: [],
      workspaceAliases: aliases,
      switchWorkspace: ctx.switchWorkspace,
    };

    await expect(
      handleRemoteSelectionAction(selectionEvent(2, token, 'tap1'), selectionContext, 'tap-1'),
    ).resolves.toMatchObject({ kind: 'handled' });
    expect(switched).toEqual([]);
    expect(channel.sent.at(-1)?.text).toContain('not switching');
    // The keyboard is gone with the answer, so a later number is not read
    // against `replace`/`cancel`.
    expect(store.selection('fake', 'chat', 'workspaces')).toBeUndefined();
    expect(pendingWorkspaceAlias('fake', 'chat')).toBeUndefined();
  });

  it('runs the switch in new-window mode when that choice is tapped', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const switched: string[] = [];
    const modes: WorkspaceSwitchModeChoice[] = [];
    const ctx = commandContext(channel, store, busyHost(), switched, modes);

    await handleRemoteCommand(textEvent('/workspace halluscribe'), ctx, 'ws-ask');
    const token = channel.selectionChoiceSends[0]!.controls.token;
    await expect(
      handleRemoteSelectionAction(
        selectionEvent(1, token, 'tap-new'),
        {
          channel,
          store,
          host: busyHost(),
          signal: new AbortController().signal,
          workspaceId: 'ws-forge',
          modelEntries: [],
          workspaceAliases: aliases,
          switchWorkspace: ctx.switchWorkspace,
        },
        'tap-new',
      ),
    ).resolves.toMatchObject({ kind: 'handled' });
    // The invariant is not only that it moved, but that it moved the way the
    // owner answered: choice 1 is the window-keeping choice, not a reload.
    expect(switched).toEqual(['halluscribe']);
    expect(modes).toEqual(['new-window']);
  });

  it('a turn running elsewhere does not talk the owner out of a new window', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const switched: string[] = [];
    const modes: WorkspaceSwitchModeChoice[] = [];
    const ctx = commandContext(channel, store, busyHost(), switched, modes);

    // `busyHost()` is streaming a conversation with no binding anywhere, so
    // stopping this window's transports would not touch it: `new-window` is
    // judged by what the transports actually cancel, while `replace` — tested
    // above — is still refused by the same window state.
    await expect(
      handleRemoteCommand(textEvent('/workspace halluscribe new-window'), ctx, 'ws-free'),
    ).resolves.toMatchObject({ kind: 'handled' });
    expect(switched).toEqual(['halluscribe']);
    expect(modes).toEqual(['new-window']);
    expect(channel.selectionChoiceSends).toHaveLength(0);
    expect(channel.sent.at(-1)?.text).toContain('opening Halluscribe in a new window');
  });

  it('a conversation bound to this channel does stop a new-window switch', async () => {
    const store = await requestStore();
    await store.setBinding({
      channel: 'fake',
      chatId: 'chat',
      workspaceId: 'ws-forge',
      conversationId: 'c1',
    });
    const channel = new FakeRemoteChannel();
    const switched: string[] = [];
    const modes: WorkspaceSwitchModeChoice[] = [];
    const ctx = commandContext(channel, store, busyHost(), switched, modes);

    await handleRemoteCommand(textEvent('/workspace halluscribe new-window'), ctx, 'ws-bound');
    expect(switched).toEqual([]);
    expect(channel.selectionChoiceSends[0]?.text).toContain('Opening Halluscribe in a new window');
    // Armed by that warning, so the second spelling is a yes to a warning the
    // owner has already read — the same rule `replace` follows.
    await handleRemoteCommand(textEvent('/workspace halluscribe new-window'), ctx, 'ws-bound-yes');
    expect(switched).toEqual(['halluscribe']);
    expect(modes).toEqual(['new-window']);
  });

  /**
   * The switch stops **every** transport this window runs, so a conversation on
   * the other channel is cut by a command that arrived on this one. A check
   * filtered to the asking channel would wave it through without a warning.
   */
  it('a WhatsApp turn answering here stops a new-window switch asked from Telegram', async () => {
    const store = await requestStore();
    await store.setBinding({
      channel: 'whatsapp',
      chatId: 'wa-chat',
      workspaceId: 'ws-forge',
      conversationId: 'c1',
    });
    const channel = new FakeRemoteChannel();
    const switched: string[] = [];
    const modes: WorkspaceSwitchModeChoice[] = [];
    const ctx = commandContext(channel, store, busyHost(), switched, modes);

    await handleRemoteCommand(textEvent('/workspace halluscribe new-window'), ctx, 'wa-busy');
    expect(switched).toEqual([]);
    // It has to say what actually moves, not only the channel this command came
    // in on, or the owner agrees to the wrong thing.
    expect(channel.selectionChoiceSends[0]?.text).toContain('every channel this window is serving');
    await handleRemoteCommand(textEvent('/workspace halluscribe new-window'), ctx, 'wa-yes');
    expect(modes).toEqual(['new-window']);
  });

  it('a queued WhatsApp prompt waits instead of being stopped, and says so', async () => {
    const store = await requestStore();
    await store.enqueue({
      id: 'b0000000-0000-4000-8000-000000000002',
      dedupKey: 'wa-queued',
      channel: 'whatsapp',
      chatId: 'wa-chat',
      providerMessageId: 'p-wa-queued',
      conversationId: 'c1',
      text: 'do this later',
      receivedAt: Date.now(),
      state: 'queued',
      updatedAt: Date.now(),
    });
    const channel = new FakeRemoteChannel();
    const switched: string[] = [];
    const ctx = commandContext(channel, store, idleHost(), switched);

    await handleRemoteCommand(textEvent('/workspace halluscribe new-window'), ctx, 'wa-queued');
    expect(switched).toEqual([]);
    const keyboard = channel.selectionChoiceSends[0];
    expect(keyboard?.text).toContain('queued prompt(s) waiting until someone switches back');
    expect(keyboard?.text).not.toContain('stops everything running');
    // The other channel's queue is this switch's business for the same reason
    // the other channel's answer is: the transports stop together.
    expect(keyboard?.text).toContain('every channel this window is serving');
  });

  it('answers a number after the refusal honestly, not with a stale range', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const switched: string[] = [];
    const ctx = commandContext(channel, store, busyHost(), switched);

    await handleRemoteCommand(textEvent('/workspace halluscribe'), ctx, 'ws-ask');
    // The keyboard replaced the numbered list, so `/workspace 4` has nothing to
    // resolve against. "pick 1-2 from the last list" would be a lie, and
    // resolving `/workspace 1` to the string `replace` would have switched the
    // chat to an alias called `replace` if the owner ever configured one.
    const miss = await handleRemoteCommand(textEvent('/workspace 4'), ctx, 'ws-number');
    expect(miss).toMatchObject({ kind: 'rejected' });
    const reason = (miss as { reason: string }).reason;
    expect(reason).toContain('replaced by the switch question');
    expect(reason).not.toContain('pick 1-');

    await handleRemoteCommand(textEvent('/workspace 1'), ctx, 'ws-one');
    expect(switched).toEqual([]);
    // The alias itself still resolves, because that is how the verbs reach a
    // transport without choice buttons.
    await expect(
      handleRemoteCommand(textEvent('/workspace halluscribe replace'), ctx, 'ws-alias-yes'),
    ).resolves.toMatchObject({ kind: 'handled' });
    expect(switched).toEqual(['halluscribe']);
  });

  it('a preflight refusal comes before the switching message', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const switched: string[] = [];
    const ctx = {
      ...commandContext(channel, store, idleHost(), switched),
      workspacePreflight: () => 'Halluscribe starts with remote off (/tmp/x/config.yaml)',
    };
    await expect(
      handleRemoteCommand(textEvent('/workspace halluscribe'), ctx, 'ws-preflight'),
    ).resolves.toMatchObject({ kind: 'rejected', reason: expect.stringContaining('remote off') });
    expect(switched).toEqual([]);
    // Nothing was promised: the chat is told the bad news instead of "the window
    // reloads, so this chat goes quiet" for a switch that never happened.
    expect(channel.sent).toHaveLength(0);
    expect(channel.selectionChoiceSends).toHaveLength(0);
  });

  it('queued work blocks the switch and says it waits, not that it stops', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const switched: string[] = [];
    const ctx = commandContext(channel, store, idleHost(), switched);
    // Nothing is answering, but a prompt is waiting to run. A reload does not
    // stop it — it leaves it waiting until someone switches back — and the
    // warning has to say which of the two harms it is.
    await store.enqueue({
      id: 'a0000000-0000-4000-8000-000000000001',
      dedupKey: 'queued-prompt',
      channel: 'fake',
      chatId: 'chat',
      providerMessageId: 'p-queued',
      conversationId: 'c1',
      text: 'do this later',
      receivedAt: Date.now(),
      state: 'queued',
      updatedAt: Date.now(),
    });

    await handleRemoteCommand(textEvent('/workspace halluscribe'), ctx, 'ws-queued');
    expect(switched).toEqual([]);
    const keyboard = channel.selectionChoiceSends[0];
    expect(keyboard?.text).toContain('Forge has queued remote requests');
    expect(keyboard?.text).toContain('queued prompt(s) waiting until someone switches back');
    expect(keyboard?.text).not.toContain('stops everything running');
  });

  it('a window reload loses the confirmation, so a late tap cannot switch', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const switched: string[] = [];
    const ctx = commandContext(channel, store, busyHost(), switched);
    const selectionContext = {
      channel,
      store,
      host: busyHost(),
      signal: new AbortController().signal,
      modelEntries: [],
      workspaceAliases: aliases,
      switchWorkspace: ctx.switchWorkspace,
    };

    await handleRemoteCommand(textEvent('/workspace halluscribe'), ctx, 'ws-ask');
    const token = channel.selectionChoiceSends[0]!.controls.token;
    // The confirmation lives in memory, so a reload drops it: a tap on the old
    // keyboard after a reload is refused rather than moving the chat blind.
    clearPendingWorkspaceConfirms();
    const late = await handleRemoteSelectionAction(
      selectionEvent(0, token, 'tap-late'),
      selectionContext,
      'tap-late',
    );
    expect(late).toMatchObject({ kind: 'rejected' });
    expect((late as { reason: string }).reason).toContain('nothing to confirm');
    expect(switched).toEqual([]);
  });

  it('✕ Close drops the confirmation the way Cancel does', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const switched: string[] = [];
    const ctx = commandContext(channel, store, busyHost(), switched);
    const selectionContext = {
      channel,
      store,
      host: busyHost(),
      signal: new AbortController().signal,
      modelEntries: [],
      workspaceAliases: aliases,
      switchWorkspace: ctx.switchWorkspace,
    };

    await handleRemoteCommand(textEvent('/workspace halluscribe'), ctx, 'ws-ask');
    const token = channel.selectionChoiceSends[0]!.controls.token;
    // Telegram's ✕ Close sits beside ✕ Cancel and reads as "no", so a typed
    // `replace` must not still switch for the rest of the 90 seconds.
    await handleRemoteSelectionAction(
      { ...selectionEvent(0, token, 'tap-close'), action: 'close' },
      selectionContext,
      'tap-close',
    );
    expect(pendingWorkspaceAlias('fake', 'chat')).toBeUndefined();
    expect(switched).toEqual([]);
    const cold = await handleRemoteCommand(
      textEvent('/workspace halluscribe replace'),
      ctx,
      'ws-after-close',
    );
    // A cold `replace` is not a rejection, it is the warning again — the same
    // shape as `/sleep confirm` for a sleep nobody asked for — so it answers
    // with a fresh keyboard and switches nothing.
    expect(cold).toMatchObject({ kind: 'handled' });
    expect(channel.selectionChoiceSends.at(-1)?.text).toContain('nothing to confirm');
    expect(switched).toEqual([]);
  });

  it('refuses a verb it does not understand instead of switching anyway', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const switched: string[] = [];
    const ctx = commandContext(channel, store, idleHost(), switched);

    // `/workspace 3 now` used to switch as if the word were not there, so a
    // mistyped answer to the warning looked like it had been accepted.
    const unknown = await handleRemoteCommand(
      textEvent('/workspace halluscribe now'),
      ctx,
      'ws-verb',
    );
    expect(unknown).toMatchObject({ kind: 'rejected' });
    expect((unknown as { reason: string }).reason).toContain('did not understand');
    expect(switched).toEqual([]);
  });
});
