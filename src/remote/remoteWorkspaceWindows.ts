/**
 * The phone's half of the window files: `/workspace windows`, its `✕` per row,
 * `/workspace cap`, and `/workspace close <n>` for a transport without choice
 * buttons.
 *
 * All three live under `/workspace` rather than as new commands, so the help
 * inventory `DocClaimsDrift.test.ts` compares against `remoteHelpText.ts` gains
 * no new command word — and that also means the words `windows`, `cap` and
 * `close` cannot name a workspace alias, the same way `list` already cannot.
 *
 * **Owner-only, and only for an unlocked session**: this module is reached from
 * `handleRemoteCommand`, which runs behind `applyRemoteAuthGate` — a locked chat
 * is challenged before any command executes, and a contact never reaches it at
 * all (`TelegramContactService.handleNonOwner` answers every non-owner text
 * before the command list). The list is never offered to a contact, so a contact
 * cannot even learn which projects the owner has open.
 *
 * Close is a *request*, never an act: this writes a file and says so. The target
 * window decides for itself on its own 5 s watch (see `RemoteWindowClose.ts`),
 * because only it knows whether it holds the lease, has unsaved editors, or has
 * something running.
 */
import { isWindowListSelection, type RemoteWindowSurface } from './RemoteWindowRegistry';
import type { RemoteRequestStore } from './RemoteRequestStore';
import { SELECTION_TTL_MS } from './RemoteSelectionConstants';
import type { RemoteChannel, RemoteInboundDisposition, RemoteInboundEvent } from './types';

type TextEvent = Extract<RemoteInboundEvent, { kind: 'text' }>;
type SelectionEvent = Extract<RemoteInboundEvent, { kind: 'selection' }>;

/** The subcommand words `/workspace` answers before it treats its argument as a workspace. */
export const WORKSPACE_WINDOWS_SUBCOMMANDS = ['windows', 'cap', 'close'] as const;

/** What the list, the cap and the close request need — a narrow slice of the command context. */
export interface WorkspaceWindowsContext {
  channel: RemoteChannel;
  store: RemoteRequestStore;
  signal: AbortSignal;
  /** Built once per window in `remoteRuntimeSetup.ts`; absent means this window has no window files. */
  windowSurface?: RemoteWindowSurface | undefined;
}

/** The same, for a tap on one of the list's `✕` buttons. */
export interface WorkspaceWindowsTapContext extends WorkspaceWindowsContext {
  /** The row the phone tapped, already resolved from the selection the tap carried. */
  windowId: string;
}

/**
 * A `workspaces` selection whose every value is a window id is the window list,
 * not the alias list — `isWindowListSelection` in `RemoteWindowRegistry.ts` owns
 * the test, because it owns the window id format.
 */
/**
 * One place to say why a window command cannot run: a window with no window
 * files has nothing to list, nothing to close and no cap to check, and that is
 * worth saying rather than pretending the alias `windows` was not found.
 */
function unavailable(): RemoteInboundDisposition {
  return {
    kind: 'rejected',
    reason: 'the open-window list is unavailable in this window',
  };
}

/**
 * `/workspace windows`, `/workspace cap [n]` and `/workspace close <n>`.
 *
 * Returns `undefined` when `first` is not one of these, so `/workspace <alias>`
 * and `/workspace <n>` keep working exactly as they did.
 */
export async function handleWorkspaceWindowsSubcommand(
  first: string | undefined,
  second: string | undefined,
  event: TextEvent,
  context: WorkspaceWindowsContext,
): Promise<RemoteInboundDisposition | undefined> {
  if (!first || !isWorkspaceWindowsSubcommand(first)) return undefined;
  if (!context.windowSurface) return unavailable();
  if (first === 'windows') return sendWindowList(event, context, context.windowSurface);
  if (first === 'cap') return workspaceCapCommand(second, event, context, context.windowSurface);
  return closeWindowByNumber(second, event, context, context.windowSurface);
}

export function isWorkspaceWindowsSubcommand(word: string): boolean {
  return (WORKSPACE_WINDOWS_SUBCOMMANDS as readonly string[]).includes(word);
}

/** `/workspace windows`: the rows, the count Forge can prove, and a `✕` per closable row. */
async function sendWindowList(
  event: TextEvent,
  context: WorkspaceWindowsContext,
  surface: RemoteWindowSurface,
): Promise<RemoteInboundDisposition> {
  const listed = await surface.list();
  const rows = listed.rows;
  const sendChoices = context.channel.selectionPages?.sendChoices;
  const canTap = sendChoices !== undefined && rows.some((row) => row.closable);
  // The selection is issued either way: `/workspace close <row>` resolves its
  // number against it, so the typed form works on a transport with no buttons.
  const token = rows.length
    ? await context.store.issueSelection(
        event.channel,
        event.chatId,
        'workspaces',
        rows.map((row) => row.windowId),
        SELECTION_TTL_MS,
      )
    : '';
  const lines = [
    `Open windows (${listed.count.total}):`,
    ...rows.map((row, index) =>
      [
        `${index + 1}. ${row.name}`,
        row.workspace,
        // The row that cannot be closed says why, in the window's own words; the
        // rest say what the button next to them does.
        row.whyNotClosable ? `— ${row.whyNotClosable}` : '— Forge can close it',
      ].join(' '),
    ),
    listed.count.otherWindows
      ? `Plus ${listed.count.otherWindows} other VS Code window${listed.count.otherWindows === 1 ? '' : 's'} Forge cannot close (no Forge in them).`
      : listed.count.counted === 'files'
        ? `Forge counted only windows it can see here — ${listed.count.probeReason ?? 'this OS'}.`
        : 'Forge counted every VS Code window this machine has open.',
    canTap
      ? 'Tap ✕ on a row to ask that window to close itself. It refuses if it is answering your phone, has unsaved editors, or has something running, and tells you either way within a minute.'
      : 'Send /workspace close <row> to ask a window to close itself. It refuses if it is answering your phone, has unsaved editors, or has something running, and tells you either way within a minute.',
    `The new-window limit is ${surface.cap()}: /workspace cap <1-12> changes it. Forge never closes a window on its own to make room.`,
  ];
  if (!canTap) {
    await context.channel.send(event.chatId, lines.join('\n'), { signal: context.signal });
    return { kind: 'handled' };
  }
  await sendChoices!(
    event.chatId,
    lines.join('\n'),
    rows
      .map((row, index) => ({ row, index }))
      .filter((entry) => entry.row.closable)
      .map((entry) => ({ label: `✕ ${entry.row.name}`, value: entry.index })),
    { kind: 'workspaces', token, page: 0, pageCount: 1 },
    { signal: context.signal },
  );
  return { kind: 'handled' };
}

/** `/workspace cap`, `/workspace cap 7`. Persisted and re-applied live, like `/ratelimit`. */
async function workspaceCapCommand(
  argument: string | undefined,
  event: TextEvent,
  context: WorkspaceWindowsContext,
  surface: RemoteWindowSurface,
): Promise<RemoteInboundDisposition> {
  if (argument === undefined) {
    await context.channel.send(
      event.chatId,
      `Forge: the new-window limit is ${surface.cap()} VS Code windows. ` +
        '/workspace cap <1-12> changes it, and /workspace windows shows what is open. ' +
        'Forge will not close a window to make room on its own.',
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  const cap = Number(argument);
  if (!Number.isInteger(cap) || cap < 1 || cap > 12) {
    return { kind: 'rejected', reason: 'usage: /workspace cap <1-12>' };
  }
  await surface.setCap(cap);
  await context.channel.send(
    event.chatId,
    `Forge: new-window limit set to ${cap} VS Code windows, saved to config.yaml. ` +
      `A switch asked at ${cap} open will be refused until you close one.`,
    { signal: context.signal },
  );
  return { kind: 'handled' };
}

/**
 * `/workspace close <n>`: the same request a `✕` tap writes, for WhatsApp and
 * any transport without choice buttons. The number is the row the person just
 * read off `/workspace windows`, so an expired list is named as the problem.
 */
async function closeWindowByNumber(
  argument: string | undefined,
  event: TextEvent,
  context: WorkspaceWindowsContext,
  surface: RemoteWindowSurface,
): Promise<RemoteInboundDisposition> {
  if (!argument || !/^\d+$/.test(argument)) {
    return { kind: 'rejected', reason: 'usage: /workspace windows, then /workspace close <row>' };
  }
  const selection = context.store.selection(event.channel, event.chatId, 'workspaces');
  if (!selection || !isWindowListSelection(selection.values)) {
    return {
      kind: 'rejected',
      reason: 'no open-window list to pick from; run /workspace windows first',
    };
  }
  const index = Number(argument) - 1;
  const windowId = selection.values[index];
  if (!windowId) {
    return {
      kind: 'rejected',
      reason: `pick 1-${selection.values.length} from the last /workspace windows list`,
    };
  }
  return requestWindowClose({ windowId, event, context, surface });
}

/** A tap on a row's `✕`, or the typed equivalent: one request, one receipt. */
export async function requestWindowClose(input: {
  windowId: string;
  event: TextEvent | SelectionEvent;
  context: WorkspaceWindowsContext;
  /** Absent when this window has no window files, which is the unavailable answer. */
  surface?: RemoteWindowSurface | undefined;
}): Promise<RemoteInboundDisposition> {
  if (!input.surface) return unavailable();
  const listed = await input.surface.list();
  const row = listed.rows.find((candidate) => candidate.windowId === input.windowId);
  // The phone may be tapping a row that went stale: the window closed, crashed,
  // or was pruned by this very read. Say that instead of writing a file nobody
  // will ever consume.
  if (!row) {
    return {
      kind: 'rejected',
      reason: 'that window is gone; run /workspace windows to see what is open now',
    };
  }
  if (!row.closable) {
    return {
      kind: 'rejected',
      reason: `Forge cannot close ${row.name} from the phone: ${row.whyNotClosable ?? 'it is answering this phone'}`,
    };
  }
  const asked = await input.surface.requestClose(input.windowId, {
    channel: input.event.channel,
    chatId: input.event.chatId,
  });
  if (!asked.ok) return { kind: 'rejected', reason: asked.reason };
  // The keyboard stays up: the owner may want to close another row, and the
  // request file is consumed once by the target whatever the keyboard does.
  await input.context.channel.send(
    input.event.chatId,
    `Forge asked ${row.name} to close itself. It will refuse if it is answering your phone, ` +
      'has unsaved editors, or has something running, and tells you either way within a minute.',
    { signal: input.context.signal },
  );
  return { kind: 'handled' };
}

/** The reason a number typed while the window list is live cannot name a workspace. */
export const WINDOW_LIST_NUMBER_REFUSAL =
  'the workspace list was replaced by the open-window list; run /workspace to see workspaces again';
