/**
 * What Forge writes into a transcript when the user acts on the turn that just
 * ended — stopped it, or pressed Undo on it — so the model learns what happened
 * instead of guessing from the next message.
 *
 * Both notes are `internal: true` user messages: they ride into the model's
 * next request and the sidebar never renders them. The wording is owned here
 * and pinned by whole-text tests, because a model that reads a reworded note
 * behaves differently from one that reads the one the fix was tuned against.
 */

import * as path from 'path';
import type { ConversationRuntime } from './sessionTypes';
import type { SidebarProviderEvents } from './providerEvents';

/** The note after an Undo that restored at least one path. */
export function undoNote(paths: readonly string[], workspaceRoot?: string): string {
  // Relative to the workspace and with forward slashes: the model reads these,
  // and it addresses a file the way the rest of the transcript names it.
  const shown = [...new Set(paths.map((absolute) => displayPath(absolute, workspaceRoot)))];
  if (shown.length === 0) {
    return '[Forge] The user pressed Undo on your last turn; no files needed restoring.';
  }
  return (
    '[Forge] The user pressed Undo on your last turn. These files are back to how they were ' +
    `before that turn: ${shown.join(', ')}. Your changes to them are gone.`
  );
}

/** The note after a turn the user stopped. It names no cause on purpose: Stop,
 * a bus `stop` and a task cap all land here, and guessing which would be a
 * claim the transcript cannot support. */
export const TURN_STOPPED_NOTE =
  '[Forge] Your last turn was stopped before it finished. The stop was not a new instruction; the next message says what to do.';

export interface TurnEndNotesWiring {
  /** Open chats only: a closed or evicted conversation has no next request to read. */
  lookup: (conversationId: string) => ConversationRuntime | undefined;
  /** A CLI agent's transcript is the CLI's own; Forge does not write into it. */
  isCliModel: (modelName: string | null) => boolean;
}

/**
 * Tell the model when its turn was stopped.
 *
 * Decorates `onGenerationFinished` the way `wireTurnMirror` does: the event
 * already fires at the right moment and carries the conversation id. Only
 * `cancelled` counts — `interrupted` is a steer, and the steering message that
 * follows says what to do instead. No persist: `SendPipeline` saves the
 * transcript once the turn is over, note included.
 */
export function wireTurnEndNotes(events: SidebarProviderEvents, deps: TurnEndNotesWiring): void {
  const original = events.onGenerationFinished;
  events.onGenerationFinished = (modelName, conversationId, finalText, outcome) => {
    original?.(modelName, conversationId, finalText, outcome);
    if (outcome !== 'cancelled' || conversationId === undefined) return;
    if (deps.isCliModel(modelName ?? null)) return;
    const conversation = deps.lookup(conversationId);
    if (!conversation) return;
    conversation.messages.push({ role: 'user', content: TURN_STOPPED_NOTE, internal: true });
  };
}

/** Workspace-relative with `/` separators, or absolute with `/` outside it. */
function displayPath(absolute: string, workspaceRoot: string | undefined): string {
  const relative = workspaceRoot ? path.relative(workspaceRoot, absolute) : absolute;
  return relative.split('\\').join('/');
}
