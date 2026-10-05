import type { CompactionOutcome } from '../sidebar/CompactionService';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import { describeBudget, handleRemoteSessionCommand } from './RemoteSessionCommands';
import { sendConversationSelection, sendWorkspaceSelection } from './RemoteSelectionPager';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type { RemoteChannel, RemoteInboundDisposition, RemoteInboundEvent } from './types';
import { QUEUED_ACK_DELETE_SECONDS } from './TelegramAcknowledgement';
import type { ModelPickerDescriptor } from '../sidebar/ModelPickerGroups';
import { PowerControl } from '../system/PowerControl';
import { handleRemotePowerCommand } from './RemotePowerCommands';
import { handleRemoteJobCommand } from './RemoteJobCommands';
import type { JobStore } from '../jobs/JobStore';
import { switchWorkspaceCommand } from './remoteWorkspaceCommand';
import { handleRemoteSettingsCommand } from './remoteSettingsCommands';
import { handleRemoteModelCommand } from './remoteModelCommands';
import { handleRemoteSessionTellCommand } from './remoteSessionTellCommands';
import { editProgress } from './remoteCommandShared';
import { resolveConversationSelection, shortId } from './remoteCommandSelectors';

export interface RemoteCommandContext {
  channel: RemoteChannel;
  store: RemoteRequestStore;
  host: ForgeHostFacade;
  workspaceId: string;
  signal: AbortSignal;
  /**
   * Arms deletion of a transient progress message (the /compact progress
   * line) after the fixed queued-ack delay, once it reaches its terminal
   * text. Optional: a missing scheduler just leaves the line undeleted,
   * same as today.
   */
  commandCleanup?: {
    armAfter: (chatId: string, messageIds: string[], delaySeconds: number) => void;
  };
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
   * Surfaces a failure that has already been absorbed — a delivery that must
   * not become a `retry` because the work it reports on is already done. Used
   * by the session-tell commands: after the mesh durably accepts a note, a
   * failed acknowledgement is logged here rather than thrown, because a throw
   * discards the control receipt and the redelivered update would enqueue the
   * same note twice.
   */
  onError?: (message: string) => void;
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
  /**
   * The persistent-jobs surface (B3): the shared `JobStore` and whether jobs are
   * enabled. Present only when the runtime wired one in; `/jobs` and `/job` are
   * inert otherwise. Kept as a narrow slice so the handler does not import the
   * store's full surface for a config read.
   */
  jobs?: { store: JobStore; enabled: boolean } | undefined;
  /**
   * Telegram contact-management commands, kept out of the normal command list.
   * Given `channel` so their replies are cleaned up like every other command's.
   */
  contactCommands?: (
    event: Extract<RemoteInboundEvent, { kind: 'text' }>,
    channel: RemoteChannel,
  ) => Promise<RemoteInboundDisposition | undefined>;
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
  const contactCommand = await context.contactCommands?.(event, context.channel);
  if (contactCommand) return contactCommand;
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
  if (context.jobs) {
    const jobCommand = await handleRemoteJobCommand(command, operands, event, {
      channel: context.channel,
      host: context.host,
      signal: context.signal,
      store: context.jobs.store,
      jobsEnabled: context.jobs.enabled,
    });
    if (jobCommand) return jobCommand;
  }
  const settingsCommand = await handleRemoteSettingsCommand(command, argument, event, context);
  if (settingsCommand) return settingsCommand;
  // The one-way /tell command remains a control receipt; reply-capable session
  // commands are admitted to the durable queue earlier by RemoteController.
  const tellCommand = await handleRemoteSessionTellCommand(command, operands, event, context);
  if (tellCommand) return tellCommand;
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
      if (progressId)
        context.commandCleanup?.armAfter(event.chatId, [progressId], QUEUED_ACK_DELETE_SECONDS);
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
    if (progressId)
      context.commandCleanup?.armAfter(event.chatId, [progressId], QUEUED_ACK_DELETE_SECONDS);
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
  const modelCommand = await handleRemoteModelCommand(command, argument, event, context);
  if (modelCommand) return modelCommand;
  return { kind: 'rejected', reason: 'unknown command' };
}
