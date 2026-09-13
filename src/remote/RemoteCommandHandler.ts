import type { CompactionOutcome } from '../sidebar/CompactionService';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import { describeBudget, handleRemoteSessionCommand } from './RemoteSessionCommands';
import {
  sendConversationSelection,
  sendModelSelection,
  sendWorkspaceSelection,
} from './RemoteSelectionPager';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type { RemoteChannel, RemoteInboundDisposition, RemoteInboundEvent } from './types';
import { collectSystemReport } from '../system/SystemReport';
import { formatSystemReport } from '../system/formatSystemReport';
import type { ModelPickerDescriptor } from '../sidebar/ModelPickerGroups';
import { PowerControl } from '../system/PowerControl';
import { handleRemotePowerCommand } from './RemotePowerCommands';
import { switchWorkspaceCommand } from './remoteWorkspaceCommand';
import {
  resolveConversationSelection,
  resolveModelSelection,
  shortId,
} from './remoteCommandSelectors';

export interface RemoteCommandContext {
  channel: RemoteChannel;
  store: RemoteRequestStore;
  host: ForgeHostFacade;
  workspaceId: string;
  signal: AbortSignal;
  inactivityTimeoutMinutes: number;
  /** Current `remote.rate_limit_per_minute`, so `/ratelimit` can report it. */
  rateLimitPerMinute: number;
  modelEntries: readonly ModelPickerDescriptor[];
  workspaceAliases: Readonly<Record<string, string>>;
  /** The alias whose configured path is this window's root, when one matches. */
  currentWorkspaceAlias?: string | undefined;
  /** Display name of the folder this window has open, alias or not. */
  currentWorkspaceName?: string | undefined;
  /** Per-chat notify_user mute, backed by RemoteController's in-memory set. */
  notifyMute?: { get: (chatId: string) => boolean; set: (chatId: string, on: boolean) => void };
  /** Per-chat turn-echo toggle, backed the same way. Separate from notifyMute
   *  because the two carry very different volumes — see RemoteController. */
  mirrorToggle?: { get: (chatId: string) => boolean; set: (chatId: string, on: boolean) => void };
  /**
   * Global spoken-reply toggle. Unlike notifyMute/mirrorToggle it is not
   * per-chat (buildSpeechDelivery is built once per transport, not per chat)
   * and it persists: set() writes voice.output.enabled to config.yaml and
   * rebuilds the transports, so it survives a window reload.
   */
  voiceToggle?: { get: () => boolean; set: (on: boolean) => Promise<void> };
  /** Continue the conversation currently bound to this remote chat. */
  resumeCurrent?: (
    event: Extract<RemoteInboundEvent, { kind: 'text' }>,
    dedupKey: string,
  ) => Promise<RemoteInboundDisposition>;
  switchWorkspace?: ((alias: string, channel: string, chatId: string) => Promise<void>) | undefined;
  setInactivityTimeout?: ((minutes: number) => Promise<void>) | undefined;
  setRateLimit?: ((perMinute: number) => Promise<void>) | undefined;
  reloadWindow?: (() => Promise<void>) | undefined;
  /**
   * Whether this channel has a TOTP enrollment, so `/reload` can say that the
   * session dies with the window. Asked rather than assumed: an installation
   * with no enrollment is never challenged, and telling that owner to have a
   * code ready would send them looking for an authenticator they never set up.
   */
  totpEnrolled?: (() => Promise<boolean>) | undefined;
}

/**
 * Stateless, so one instance serves every chat and every transport. A second
 * would be a second owner of the same `powercfg`/`schtasks` spawn sites.
 */
const powerControl = new PowerControl();

export async function handleRemoteCommand(
  event: Extract<RemoteInboundEvent, { kind: 'text' }>,
  context: RemoteCommandContext,
  dedupKey: string,
): Promise<RemoteInboundDisposition> {
  const admission = await context.store.beginControlEvent(dedupKey);
  if (admission === 'completed') return { kind: 'handled' };
  if (admission === 'unknown') {
    return { kind: 'rejected', reason: 'previous command outcome is unknown; resend it' };
  }
  try {
    const result = await executeRemoteCommand(event, context, dedupKey);
    await context.store.finishControlEvent(dedupKey);
    return result;
  } catch (err) {
    await context.store.discardControlEvent(dedupKey);
    throw err;
  }
}

async function executeRemoteCommand(
  event: Extract<RemoteInboundEvent, { kind: 'text' }>,
  context: RemoteCommandContext,
  dedupKey: string,
): Promise<RemoteInboundDisposition> {
  // Split whole: `/workspace list 2` needs two operands, and a limit of 2 threw
  // the page number away, so the documented page fallback never paged.
  const [command, ...operands] = event.text.trim().split(/\s+/);
  const argument = operands[0];
  const sessionCommand = await handleRemoteSessionCommand(command, argument, event, context);
  if (sessionCommand) return sessionCommand;
  const powerCommand = await handleRemotePowerCommand(command, operands, event, {
    channel: context.channel,
    host: context.host,
    signal: context.signal,
    power: powerControl,
  });
  if (powerCommand) return powerCommand;
  if (command === '/clanker') {
    const desired = argument?.toLowerCase();
    if (desired !== 'on' && desired !== 'off') {
      return { kind: 'rejected', reason: 'usage: /clanker on|off' };
    }
    // Owner-authenticated command, never a tool: a model that could call this
    // would be able to switch off its own approval gate mid-turn.
    context.host.setClankerMode(desired === 'on');
    await context.channel.send(
      event.chatId,
      desired === 'on'
        ? 'Forge: clanker mode ON — non-dangerous tools now run with no approval, here or in the sidebar, for every tab in this window. It covers this workspace, and stays armed across a window reload until it is turned off.'
        : 'Forge: clanker mode OFF — tool approvals are gated again in this workspace, and stay gated across a reload.',
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  if (command === '/timeout') {
    if (!argument) {
      await context.channel.send(
        event.chatId,
        `Forge: remote inactivity timeout is ${
          context.inactivityTimeoutMinutes === 0
            ? 'off'
            : `${context.inactivityTimeoutMinutes} minutes`
        }.`,
        { signal: context.signal },
      );
      return { kind: 'handled' };
    }
    const minutes = argument.toLowerCase() === 'off' ? 0 : Number(argument);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1_440) {
      return { kind: 'rejected', reason: 'usage: /timeout <1-1440|off>' };
    }
    if (!context.setInactivityTimeout) {
      return { kind: 'rejected', reason: 'remote timeout configuration is unavailable' };
    }
    await context.setInactivityTimeout(minutes);
    await context.channel.send(
      event.chatId,
      `Forge: remote inactivity timeout ${minutes === 0 ? 'disabled' : `set to ${minutes} minutes`}.`,
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  if (command === '/ratelimit') {
    if (!argument) {
      await context.channel.send(
        event.chatId,
        `Forge: remote rate limit is ${context.rateLimitPerMinute} messages per minute.`,
        { signal: context.signal },
      );
      return { kind: 'handled' };
    }
    // `off` maps to the schema ceiling rather than removing the limiter. The
    // limiter is the only backstop the Telegram poll loop has against a single
    // poisoned update being redelivered forever; a true “off” would trade a
    // visible error for a silent hot loop.
    const perMinute = argument.toLowerCase() === 'off' ? 600 : Number(argument);
    if (!Number.isInteger(perMinute) || perMinute < 1 || perMinute > 600) {
      return { kind: 'rejected', reason: 'usage: /ratelimit <1-600|off>' };
    }
    if (!context.setRateLimit) {
      return { kind: 'rejected', reason: 'remote rate limit configuration is unavailable' };
    }
    await context.setRateLimit(perMinute);
    await context.channel.send(
      event.chatId,
      `Forge: remote rate limit set to ${perMinute} messages per minute.`,
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  if (command === '/compact') {
    const binding = context.store.binding(event.channel, event.chatId);
    if (!binding) return { kind: 'rejected', reason: 'no conversation is bound' };
    const progressId = await context.channel
      .sendProgress?.(event.chatId, 'Forge: compacting…', { signal: context.signal })
      .catch(() => undefined);
    let outcome: CompactionOutcome;
    try {
      outcome = await context.host.compact(binding.conversationId, {
        trigger: 'remote',
        remoteOrigin: { channel: event.channel, chatId: event.chatId },
      });
    } catch (err) {
      // Only a throw from host.compact itself (no outcome available) edits the
      // progress line to failed; the error then flows through the existing
      // command error path below.
      await editProgress(context.channel, event.chatId, progressId, 'Forge: compaction failed.');
      throw err;
    }
    // Edit the progress line from the captured outcome BEFORE the authoritative
    // result send, so a send failure after a successful compaction never
    // displays a false "failed" state.
    await editProgress(
      context.channel,
      event.chatId,
      progressId,
      outcome === 'compacted'
        ? 'Forge: compaction complete.'
        : outcome === 'skipped'
          ? 'Forge: compaction skipped.'
          : 'Forge: compaction failed.',
    );
    const budget = context.host.contextBudget(binding.conversationId);
    await context.channel.send(
      event.chatId,
      `Forge: compaction ${outcome}. Context: ${describeBudget(budget)}`,
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  if (command === '/workspace') {
    // `/workspace` lists and numbers the workspaces; `/workspace 27` goes to
    // number 27. It used to read that number as a PAGE, so the one command
    // carried two number spaces and answered `/workspace 27` with "takes a
    // page number (1-3)" — for the workspace the user had just read off this
    // very list. Paging is the inline keyboard's job now. `list` still parses
    // as a no-op verb so the namespace stays open for the create/confirm
    // subcommands the remote plan has queued behind it.
    const [first, second] = operands;
    const selector = first === 'list' ? second : first;
    if (selector === undefined) return sendWorkspaceSelection(event, context);
    return switchWorkspaceCommand(selector, event, context);
  }
  // `/new <n>` is retained as a silent alias: it is in muscle memory and in
  // older help screenshots. `/workspace <n>` is the documented spelling,
  // because `/new` reads as "make me a new one" and never joined anything.
  if (command === '/new' && argument) {
    return switchWorkspaceCommand(argument, event, context);
  }
  if (command === '/new') {
    const conv = await context.host.createConversation({ activate: false });
    await context.store.setBinding({
      channel: event.channel,
      chatId: event.chatId,
      workspaceId: context.workspaceId,
      conversationId: conv.id,
    });
    await context.channel.send(event.chatId, `Forge: bound to a new chat (${shortId(conv.id)}).`, {
      signal: context.signal,
    });
    return { kind: 'handled' };
  }
  // `/chats` lists, `/chat <n>` picks — the same plural/singular pair as
  // `/models` and `/model`. `/list` and `/select` stay as silent aliases: they
  // are in muscle memory and in older help text screenshots.
  if (command === '/chats' || command === '/list') {
    return sendConversationSelection(event, context, argument);
  }
  if ((command === '/chat' || command === '/select' || command === '/resume') && argument) {
    // A numbered selection normally resolves through the last /chats pager,
    // which preserves the exact list the person saw.  Do not make that pager a
    // prerequisite, though: `/chat 2` is useful (and documented) by itself.
    // Fall back to the same newest-first order the pager uses instead of trying
    // to restore a conversation literally named "2".
    // Titles carry spaces ("Untitled chat"), so the whole remainder is the
    // selector here — a single number joins to itself and still resolves.
    const selector = operands.join(' ');
    const conversationId = resolveConversationSelection(context, event, selector) ?? selector;
    // restoreConversation THROWS when the tab cannot be opened — the
    // MAX_CONVERSATIONS cap, or an id that is not in history. An uncaught throw
    // here became a `retry` disposition, which the Telegram poll loop answers by
    // redelivering the same update without advancing its offset: one `/select 1`
    // produced ~30 inbound events in four seconds and stopped only because the
    // rate limiter began rejecting them. The user then saw "rate limit
    // exceeded" and never saw the real reason. Rejecting names the cause and
    // advances the offset.
    let conv: Awaited<ReturnType<typeof context.host.restoreConversation>>;
    try {
      conv = await context.host.restoreConversation(conversationId, { activate: false });
    } catch (err) {
      // A bare "could not be restored" sends the user looking for a missing
      // conversation when what they typed was a name or a stale number. Name
      // the list that numbers them instead — a refusal that does not point at
      // the sanctioned move teaches the capability does not exist.
      const cause = err instanceof Error ? err.message : String(err);
      return {
        kind: 'rejected',
        reason:
          conversationId === selector && !/^\d+$/.test(selector)
            ? `no conversation matches “${selector}”; run /chats, then /chat <number>`
            : cause,
      };
    }
    await context.store.setBinding({
      channel: event.channel,
      chatId: event.chatId,
      workspaceId: context.workspaceId,
      conversationId: conv.id,
    });
    await context.channel.send(
      event.chatId,
      `Forge: selected ${conv.title} (${shortId(conv.id)}).`,
      {
        signal: context.signal,
      },
    );
    return { kind: 'handled' };
  }
  if (command === '/chat' || command === '/select') {
    return {
      kind: 'rejected',
      reason: 'usage: /chat <number-or-name>; /chats lists and numbers them',
    };
  }
  // A numbered /resume is retained as a compatibility alias for /chat.
  // Bare /resume continues the conversation already bound to this chat, so a
  // remote user can restart a cold model without inventing “Ready?”.
  if (command === '/resume') {
    if (!context.resumeCurrent) {
      return { kind: 'rejected', reason: 'resume is unavailable in this window' };
    }
    return context.resumeCurrent(event, dedupKey);
  }
  if (command === '/models') {
    return sendModelSelection(event, context, argument);
  }
  if (command === '/model' && argument) {
    const binding = context.store.binding(event.channel, event.chatId);
    if (!binding) return { kind: 'rejected', reason: 'no conversation is bound' };
    const status = context.host.status();
    if (
      status.requestChains.some((chain) => chain.conversationId === binding.conversationId) ||
      status.streamingConversationIds.includes(binding.conversationId) ||
      context.store.queued(binding.conversationId).length > 0
    ) {
      return { kind: 'rejected', reason: 'the bound conversation is busy or has queued work' };
    }
    const modelName = resolveModelSelection(context, event, argument);
    if (!modelName || !context.modelEntries.some((model) => model.name === modelName)) {
      return { kind: 'rejected', reason: 'model is unavailable; use /models' };
    }
    await context.host.setConversationModel(binding.conversationId, modelName);
    await context.channel.send(event.chatId, `Forge: pinned ${modelName} to this chat.`, {
      signal: context.signal,
    });
    return { kind: 'handled' };
  }
  // /model with no argument lists the models, the way /chats and /workspace do
  // with no argument — a bare command is a request to see the list, not a
  // failed pick.
  if (command === '/model') {
    return sendModelSelection(event, context, undefined);
  }
  if (command === '/system') {
    // Deliberately not gated on a busy window: "what is holding the VRAM" is
    // the question a user asks precisely while a turn is running, and the
    // probes read counters without touching anything the turn owns.
    const report = await collectSystemReport({
      backendProcesses: () => context.host.backendProcesses?.() ?? [],
    });
    const text = formatSystemReport(report, {
      compact: true,
      telegramHtml: context.channel.sendHtml !== undefined,
    });
    if (context.channel.sendHtml) {
      await context.channel.sendHtml(event.chatId, text, { signal: context.signal });
    } else {
      await context.channel.send(event.chatId, text, { signal: context.signal });
    }
    return { kind: 'handled' };
  }
  if (command === '/unload') {
    const idleReason = globalBusyReason(context);
    if (idleReason) return { kind: 'rejected', reason: idleReason };
    await context.host.unloadModels();
    await context.channel.send(
      event.chatId,
      'Forge: all models unloaded, memory released. Send a prompt to start the backend again.',
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  if (command === '/restart') {
    const idleReason = globalBusyReason(context);
    if (idleReason) return { kind: 'rejected', reason: idleReason };
    const binding = context.store.binding(event.channel, event.chatId);
    const modelName = binding
      ? context.host.status().conversations.find((item) => item.id === binding.conversationId)
          ?.activeModel
      : undefined;
    if (!modelName) {
      return {
        kind: 'rejected',
        reason: 'this chat has no explicitly pinned model; use /models then /model',
      };
    }
    await context.host.restartModel(modelName);
    await context.channel.send(event.chatId, `Forge: restarted ${modelName}.`, {
      signal: context.signal,
    });
    return { kind: 'handled' };
  }
  return { kind: 'rejected', reason: 'unknown command' };
}

/** Best-effort edit of a progress message; silently skipped when unsupported. */
async function editProgress(
  channel: RemoteChannel,
  chatId: string,
  messageId: string | undefined,
  text: string,
): Promise<void> {
  if (!messageId || !channel.editMessage) return;
  await channel.editMessage(chatId, messageId, text).catch(() => undefined);
}

function globalBusyReason(context: RemoteCommandContext): string | undefined {
  const status = context.host.status();
  if (
    status.requestChains.length ||
    status.streamingConversationIds.length ||
    status.pendingApproval
  ) {
    return 'Forge is busy; wait for requests, streams, and approvals to finish';
  }
  return context.store.queued().length > 0 ? 'Forge has queued remote requests' : undefined;
}
