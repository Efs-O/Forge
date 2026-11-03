/**
 * Going to another workspace: `/workspace <n-or-alias>`, plus the warning that
 * comes back when a switch would cut something that is running.
 *
 * Owner of the preflight for that move — resolving the number off the last
 * list, refusing the no-op, saying what the silence means, and holding the
 * confirmation a busy switch needs. The move itself spans two processes (see
 * `RemoteWorkspaceHandoff`): this window records it and closes, and the window
 * that comes up sends its own arrival receipt.
 */
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import { globalBusyReason, transportsBusyReason } from './remoteCommandShared';
import { numberedSelectionMiss, resolveSelection } from './remoteCommandSelectors';
import type { RemoteRequestStore } from './RemoteRequestStore';
import { SELECTION_TTL_MS } from './RemoteSelectionConstants';
import type {
  RemoteChannel,
  RemoteInboundDisposition,
  RemoteInboundEvent,
  WorkspaceSwitchModeChoice,
} from './types';

export type { WorkspaceSwitchModeChoice };

/** The slice of `RemoteCommandContext` the switch needs. */
export interface WorkspaceSwitchContext {
  channel: RemoteChannel;
  store: RemoteRequestStore;
  host: ForgeHostFacade;
  signal: AbortSignal;
  /** What a `new-window` switch has to know: the conversations bound to this
   *  workspace and channel are the ones the switch moves or strands. */
  workspaceId: string;
  workspaceAliases: Readonly<Record<string, string>>;
  currentWorkspaceAlias?: string | undefined;
  currentWorkspaceName?: string | undefined;
  switchWorkspace?:
    | ((
        alias: string,
        channel: string,
        chatId: string,
        mode: WorkspaceSwitchModeChoice,
      ) => Promise<() => Promise<void>>)
    | undefined;
  /**
   * What the target window will load, asked **before** this window says
   * "switching…" and stops answering: a refusal after that message would be a
   * promise the switch never had any chance of keeping. See
   * `remoteWorkspacePreflight`.
   */
  workspacePreflight?: (alias: string, channel: string) => string | undefined;
}

/**
 * What the confirm keyboard can answer. `new-window` is phase 2 of
 * `docs/plans/TELEGRAM_WORKSPACE_SWITCH_SAFETY_PLAN.md`: it opens the target in
 * a second VS Code window and keeps this one, so the owner is offered the choice
 * that does not destroy the window they are looking at.
 */
export type WorkspaceSwitchMode = 'replace' | 'new-window' | 'cancel';

/** The two modes that actually move the chat, for the switch itself. */
/** Stored as the selection's values, so a tap resolves by index and the
 *  keyboard can grow without breaking one that is already on screen. */
export const WORKSPACE_MODE_VALUES: WorkspaceSwitchMode[] = ['replace', 'new-window', 'cancel'];

/** How long a refused `/workspace` stays confirmable. Short on purpose: the
 *  danger is the reload itself, and a stale yes must not outlive the warning
 *  that earned it. `/sleep` uses 90 s for the same reason. */
const CONFIRM_WINDOW_MS = 90_000;

interface PendingConfirm {
  alias: string;
  expiresAt: number;
}

/**
 * In-process, exactly as `/sleep` keeps its confirmation
 * (`RemotePowerCommands.ts`): a window reload loses it and the next
 * `/workspace <n>` re-asks. Keeping it out of `remote-state-v2.json` is a
 * decision, not an omission — a new `selections[]` field or `kind` value would
 * make an older window's parse **throw** rather than strip (`RemoteStoreSchemas`
 * keeps `kind` a `z.enum`), and that would leave every not-yet-reloaded window
 * unable to load, refresh or claim for the whole life of the confirmation.
 */
const pendingConfirms = new Map<string, PendingConfirm>();

const confirmKey = (channel: string, chatId: string): string => `${channel}:${chatId}`;

/** Test seam: drops any confirmation this process is holding. */
export function clearPendingWorkspaceConfirms(): void {
  pendingConfirms.clear();
}

/** Drops a confirmation without consuming it as a yes — the cancel path. */
export function dropWorkspaceConfirm(channel: string, chatId: string): void {
  pendingConfirms.delete(confirmKey(channel, chatId));
}

/** The alias a confirmation is still waiting for, without consuming it. */
export function pendingWorkspaceAlias(
  channel: string,
  chatId: string,
): { alias: string } | undefined {
  const key = confirmKey(channel, chatId);
  const held = pendingConfirms.get(key);
  if (!held) return undefined;
  if (held.expiresAt < Date.now()) {
    pendingConfirms.delete(key);
    return undefined;
  }
  return { alias: held.alias };
}

/** Consumes the confirmation for this chat, or says why there is none. */
export function takeWorkspaceConfirm(
  channel: string,
  chatId: string,
  alias: string,
): { ok: true } | { ok: false; reason: string } {
  const key = confirmKey(channel, chatId);
  const held = pendingConfirms.get(key);
  pendingConfirms.delete(key);
  if (!held || held.expiresAt < Date.now())
    return {
      ok: false,
      reason:
        `nothing to confirm — send /workspace ${alias} first (a confirmation expires ` +
        `after ${Math.round(CONFIRM_WINDOW_MS / 1000)} seconds)`,
    };
  if (held.alias !== alias)
    return { ok: false, reason: `the confirmation you were offered was for ${held.alias}` };
  return { ok: true };
}

export async function switchWorkspaceCommand(
  selector: string,
  event: Extract<RemoteInboundEvent, { kind: 'text' }>,
  context: WorkspaceSwitchContext,
  verb?: string,
): Promise<RemoteInboundDisposition> {
  // A number means the last `/workspace` list, matching /model <n> and
  // /chat <n>; an alias keeps working so a remembered name does not depend on
  // having listed first.
  //
  // A live confirm keyboard means the list is gone, because the keyboard reuses
  // the same `workspaces` record and holds only `replace`/`cancel`. Numbers and
  // the two mode words must then be refused rather than resolved: answering
  // `/workspace 4` with "pick 1-2 from the last list" is a lie, and resolving
  // `/workspace 1` to the string `replace` would switch the chat to an alias
  // called `replace` if one ever existed. An alias typed in full still works,
  // because that is how the verbs reach a transport without choice buttons.
  const stored = context.store.selection(event.channel, event.chatId, 'workspaces');
  const modeRecord =
    !!stored &&
    stored.values.length === WORKSPACE_MODE_VALUES.length &&
    stored.values.every((value, index) => value === WORKSPACE_MODE_VALUES[index]);
  const ambiguous =
    modeRecord &&
    (/^\d+$/.test(selector) || (WORKSPACE_MODE_VALUES as string[]).includes(selector));
  const alias = ambiguous
    ? undefined
    : (resolveSelection(context, event, 'workspaces', selector) ?? selector);
  if (alias === undefined) {
    return {
      kind: 'rejected',
      reason:
        'the workspace list was replaced by the switch question; run /workspace again, or answer with the workspace name and replace',
    };
  }
  if (!context.workspaceAliases[alias]) {
    // A number that resolves to nothing means the list expired or never ran,
    // not that the workspace is missing — saying “not found” for a number the
    // user just read off a list sends them looking for the wrong problem.
    return { kind: 'rejected', reason: numberedSelectionMiss(context, event, selector) };
  }
  if (!context.switchWorkspace) {
    return { kind: 'rejected', reason: 'workspace switching is unavailable in this window' };
  }
  // Switching costs a window reload and the remote session with it, so doing it
  // to arrive where the chat already is would drop the session for nothing.
  if (alias === context.currentWorkspaceAlias) {
    return {
      kind: 'rejected',
      reason:
        `this chat is already in ${context.workspaceAliases[alias]}; ` +
        '/chats lists the conversations here and /new starts one',
    };
  }
  const wanted = (verb ?? '').toLowerCase();
  if (wanted && !['replace', 'confirm', 'new', 'new-window', 'cancel'].includes(wanted)) {
    return {
      kind: 'rejected',
      reason:
        `I did not understand “${verb}”. A busy switch is answered with \`replace\`, ` +
        '`new-window` or `cancel`; `/workspace <name>` with nothing after it switches.',
    };
  }
  if (wanted === 'cancel') {
    pendingConfirms.delete(confirmKey(event.channel, event.chatId));
    await context.channel.send(
      event.chatId,
      'Forge: not switching — this chat stays where it is.',
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  const mode: WorkspaceSwitchModeChoice =
    wanted === 'new' || wanted === 'new-window' ? 'new-window' : 'replace';
  // Each mode is judged by what it actually destroys. `replace` reloads the
  // window, so it is blocked by anything running in it (`globalBusyReason`:
  // typed-in turns, jobs, delegated agents). `new-window` only stops the
  // transports, which cancel the conversations bound to this workspace and
  // nothing else — but they stop **every** channel, so a WhatsApp turn is cut
  // by a switch asked from Telegram and must be warned about here too.
  const blocked =
    mode === 'new-window'
      ? transportsBusyReason({
          host: context.host,
          store: context.store,
          workspaceId: context.workspaceId,
        })
      : globalBusyReason(context);
  // Ask the target's config before asking the owner anything: both answers of
  // the mode keyboard land in the **same** window, so if that window cannot
  // answer the phone there is no question worth asking, and the refusal is
  // identical for either mode. `runWorkspaceSwitch` asks again at switch time,
  // because the config may have changed between the offer and the answer.
  const refused = context.workspacePreflight?.(alias, event.channel);
  if (refused) return { kind: 'rejected', reason: refused };
  if (!blocked && wanted) {
    // A mode typed by hand, and nothing this switch would cut: one command and
    // it happens, exactly as it always has. With no typed mode the owner has
    // not said which of the two moves they want, so the keyboard asks — idle or
    // busy alike. The owner's own run on 2026-10-30 is why: they picked a
    // workspace from the list while nothing was running, got `replace` at once,
    // and never saw the new-window choice that would have kept their window.
    return runWorkspaceSwitch(alias, event.channel, event.chatId, context, mode);
  }
  // No mode typed, so the owner is asked — and asked about what each answer
  // costs. A reload stops every turn in this window (typed-in turns, jobs,
  // delegated agents, not only this chat), a new window stops the transports
  // and moves the whole connection, and when something is running the warning
  // leads with what is actually running instead of a paraphrase of it.
  if (wanted) {
    const taken = takeWorkspaceConfirm(event.channel, event.chatId, alias);
    // Busy at ask and busy at confirm is the path the owner accepted. Busy at
    // ask and idle at confirm goes ahead too: the answer may have finished in
    // between, and stopping it was already agreed to.
    if (taken.ok) return runWorkspaceSwitch(alias, event.channel, event.chatId, context, mode);
    // Cold, expired, or offered for another workspace: this reply is the
    // warning, and it arms the confirmation, so a yes always follows a warning.
    return offerSwitchConfirm(context, event, alias, taken.reason, blocked);
  }
  return offerSwitchConfirm(context, event, alias, '', blocked);
}

/**
 * The refusal, the warning and the two buttons, plus plain text on a transport
 * without native choice buttons so the verbs work everywhere.
 *
 * Reuses the `workspaces` selection record, which means it replaces the
 * numbered list this chat was reading: the alias is carried by the pending
 * confirmation instead, and `switchWorkspaceCommand` refuses a number while
 * that record is live rather than answering with a stale range. A cleaner
 * selection `kind` is not available — an older window's parse of an unknown
 * kind throws instead of stripping.
 */
async function offerSwitchConfirm(
  context: WorkspaceSwitchContext,
  event: Extract<RemoteInboundEvent, { kind: 'text' }>,
  alias: string,
  extra: string,
  busy: string | undefined,
): Promise<RemoteInboundDisposition> {
  pendingConfirms.set(confirmKey(event.channel, event.chatId), {
    alias,
    expiresAt: Date.now() + CONFIRM_WINDOW_MS,
  });
  const name = context.workspaceAliases[alias];
  const here = context.currentWorkspaceName ?? 'this workspace';
  const command = event.text.trim().split(/\s+/)[0] ?? '/workspace';
  // Lead with the reason the gate computed, not a paraphrase of it: the gate
  // knows about active request chains and queued work, and a line built only
  // from streaming state answers "Forge is busy" to a job between rounds.
  // The trailing "wait for requests, streams and approvals to finish" clause
  // is dropped here only — `/unload` and `/restart` need that instruction, and
  // this message asks for the opposite choice, so keeping it would tell the
  // owner to wait while offering to go ahead now.
  // The gates return `undefined` when nothing would be cut, not an empty
  // string, so this is a truthiness test — `busy === ''` looked right and
  // crashed on the idle path the first time it ran.
  const idle = !busy;
  const status = context.host.status();
  const streaming = status.conversations.find((conversation) =>
    status.streamingConversationIds.includes(conversation.id),
  );
  const active =
    status.requestChains.length > 0 ||
    status.streamingConversationIds.length > 0 ||
    status.pendingApproval !== undefined;
  const lead = busy
    ? [
        busy.split(';')[0] ?? busy,
        streaming?.activeModel ? `${streaming.activeModel} is answering` : '',
        status.pendingApproval ? 'a tool approval is waiting' : '',
      ]
        .filter(Boolean)
        .join(' — ')
    : 'Nothing is running here';
  const moves =
    ' and your whole Forge connection on this channel moves with the switch: any other chat ' +
    `bound to ${here} is refused until someone switches back`;
  const harm = idle
    ? `Replace this window, or open ${name} in a new window and keep this one?`
    : active
      ? `Switching to ${name} stops everything running here — this answer, any job, and any agent it has asked —${moves}.`
      : `Nothing is answering right now, but switching to ${name} leaves ${
          context.store.queued().length
        } queued prompt(s) waiting until someone switches back,${moves}.`;
  const text = [
    [extra, lead].filter(Boolean).join(': '),
    harm,
    // The other choice has to be described honestly: it keeps this window, but
    // it does not keep this window's phone connections — `stopActive()` takes
    // every channel down, not only the one this command came in on.
    `Opening ${name} in a new window keeps this window open, but your whole Forge connection moves there — every channel this window is serving, not only this one — so anything answering on those transports stops and any other chat bound to ${here} is refused until someone switches back. A turn you typed into this window is the one thing that choice does not stop.`,
    `Tap a choice, or reply \`${command} ${alias} replace\`, \`${command} ${alias} new-window\` or \`${command} ${alias} cancel\` to leave it alone.`,
  ].join('\n');
  const sendChoices = context.channel.selectionPages?.sendChoices;
  if (!sendChoices) {
    await context.channel.send(event.chatId, text, { signal: context.signal });
    return { kind: 'handled' };
  }
  const token = await context.store.issueSelection(
    event.channel,
    event.chatId,
    'workspaces',
    WORKSPACE_MODE_VALUES,
    SELECTION_TTL_MS,
  );
  await sendChoices(
    event.chatId,
    text,
    [
      {
        label: idle
          ? '⚠ Replace this window (reloads it)'
          : '⚠ Replace this window (stops everything running)',
        value: 0,
      },
      { label: '↗ Open in a new window (keeps this one)', value: 1 },
      { label: '✕ Cancel', value: 2 },
    ],
    { kind: 'workspaces', token, page: 0, pageCount: 1 },
    { signal: context.signal },
  );
  return { kind: 'handled' };
}

/** The move itself, shared by the idle path and the confirmed one. */
export async function runWorkspaceSwitch(
  alias: string,
  channel: string,
  chatId: string,
  context: WorkspaceSwitchContext,
  mode: WorkspaceSwitchModeChoice = 'replace',
): Promise<RemoteInboundDisposition> {
  const switchWorkspace = context.switchWorkspace;
  if (!switchWorkspace) {
    return { kind: 'rejected', reason: 'workspace switching is unavailable in this window' };
  }
  // Ask first, both modes: the phone is about to move to a window that has to
  // be able to answer it, and a target that starts with remote off would take
  // the chat and never speak again.
  const refused = context.workspacePreflight?.(alias, channel);
  if (refused) return { kind: 'rejected', reason: refused };
  pendingConfirms.delete(confirmKey(channel, chatId));
  // Says what the silence that follows means, and says it differently per mode:
  // in `replace` the VS Code window reloads, so this chat hears nothing until
  // the new window's transport comes up; in `new-window` this window survives
  // but stops serving this channel, so the phone is answering somewhere else
  // from the moment the switch runs.
  await context.channel.send(
    chatId,
    mode === 'new-window'
      ? `Forge: opening ${context.workspaceAliases[alias]} in a new window… this window stays open, but your Forge connection on this channel moves to the new one as soon as it is up — I will message you from there.`
      : `Forge: switching to ${context.workspaceAliases[alias]}… the window reloads, so this chat goes quiet for a few seconds — I will message you when it is back.`,
    { signal: context.signal },
  );
  const finishSwitch = await switchWorkspace(alias, channel, chatId, mode);
  return { kind: 'handled', afterHandled: finishSwitch };
}
