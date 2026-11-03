/**
 * The tap that answers a refused `/workspace <n>`: replace this window, or
 * cancel. `new-window` joins it with phase 2 of
 * `docs/plans/TELEGRAM_WORKSPACE_SWITCH_SAFETY_PLAN.md`.
 *
 * Its own module for the same reason the other command families are: the
 * selection pager must not import the workspace command's siblings directly, and
 * the workspace route needs one field the selection context does not carry.
 */
import type { RemoteSelectionContext } from './RemoteSelectionPager';
import {
  dropWorkspaceConfirm,
  pendingWorkspaceAlias,
  runWorkspaceSwitch,
  takeWorkspaceConfirm,
} from './remoteWorkspaceCommand';
import type { RemoteInboundDisposition, RemoteInboundEvent } from './types';

type SelectionEvent = Extract<RemoteInboundEvent, { kind: 'selection' }>;

export async function selectWorkspaceMode(
  event: SelectionEvent,
  context: RemoteSelectionContext,
): Promise<RemoteInboundDisposition> {
  if (event.choice === undefined)
    return { kind: 'rejected', reason: 'workspace choice is invalid' };
  const selection = context.store.selection(
    event.channel,
    event.chatId,
    event.selectionKind,
    event.selectionToken,
  );
  if (!selection || event.choice >= selection.values.length) {
    return { kind: 'rejected', reason: 'workspace choice expired; run /workspace again' };
  }
  const mode = selection.values[event.choice]!;
  // The confirm keyboard replaced the numbered workspace list, so the alias it
  // was answering lives in the pending confirmation, not in these values.
  const pending = pendingWorkspaceAlias(event.channel, event.chatId);
  if (!pending) {
    return {
      kind: 'rejected',
      reason: 'nothing to confirm — run /workspace again (a confirmation expires after 90 seconds)',
    };
  }
  if (mode === 'cancel') {
    // A "no" must kill the yes as well as the keyboard: leaving the pending
    // confirmation armed would let a later `replace` switch on the strength of
    // a warning this chat had already refused.
    dropWorkspaceConfirm(event.channel, event.chatId);
    await context.store.clearSelection(
      event.channel,
      event.chatId,
      event.selectionKind,
      event.selectionToken,
    );
    await context.channel.send(
      event.chatId,
      'Forge: not switching — this chat stays where it is. Run /workspace to see the list again.',
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  // A redelivered callback or a second tap lands here with the confirmation
  // already consumed, so it is refused instead of starting a second handoff.
  const taken = takeWorkspaceConfirm(event.channel, event.chatId, pending.alias);
  if (!taken.ok) return { kind: 'rejected', reason: taken.reason };
  // Clear the keyboard the way cancel does: leaving it up invites a second tap
  // on a question that has already been answered, which is refused but still
  // reads as "nothing happened".
  await context.store.clearSelection(
    event.channel,
    event.chatId,
    event.selectionKind,
    event.selectionToken,
  );
  return runWorkspaceSwitch(
    pending.alias,
    event.channel,
    event.chatId,
    context,
    mode === 'new-window' ? 'new-window' : 'replace',
  );
}
