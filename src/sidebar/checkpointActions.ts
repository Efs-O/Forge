/**
 * The checkpoint bar's actions — Review, Undo, Keep — and what Undo tells the
 * model afterwards.
 *
 * Split out of `SidebarProvider` because the provider is the wiring file: these
 * actions reach the checkpoint stack, the code lens and the transcript, none of
 * which the provider owns. `SidebarProvider` keeps one-line methods of the same
 * names, so every caller (the webview router, `/undo`, the code lens) is
 * unchanged.
 */

import type { CheckpointStack } from '../checkpoint/CheckpointStack';
import type { CheckpointReview } from './CheckpointReview';
import type { KeepUndoCodeLensProvider } from './KeepUndoCodeLens';
import type { HostToWebview } from './messageBridge';
import type { ConversationRuntime } from './sessionTypes';
import { undoNote } from './turnEndNotes';

export interface CheckpointActionsDeps {
  checkpoints: CheckpointStack;
  codeLens: KeepUndoCodeLensProvider;
  review: CheckpointReview;
  post: (message: HostToWebview) => void;
  /** The chat these actions act on, as the webview sees it. */
  activeConversationId: () => string;
  /** Open chats only: an archived transcript has no turn left to be told. */
  findConversation: (conversationId: string) => ConversationRuntime | undefined;
  persist: (conversationId: string) => void;
  workspaceRoot?: string;
}

export interface CheckpointActions {
  reviewCheckpoint: () => Promise<void>;
  undo: () => Promise<string[]>;
  keep: () => Promise<void>;
  canUndo: () => boolean;
}

export function createCheckpointActions(deps: CheckpointActionsDeps): CheckpointActions {
  const dismiss = (conversationId: string): void => {
    deps.codeLens.clearPending();
    deps.post({ type: 'checkpointDismissed', conversationId });
  };
  return {
    /** Opens the active turn's changes in VS Code's native diff editor. */
    async reviewCheckpoint(): Promise<void> {
      await deps.review.open(deps.checkpoints.pendingSnapshots(deps.activeConversationId()));
    },
    async undo(): Promise<string[]> {
      const conversationId = deps.activeConversationId();
      const restored = await deps.checkpoints.undo(conversationId);
      dismiss(conversationId);
      // Undo runs outside a turn, so nothing else saves this transcript: the
      // note has to be persisted here, or the model wakes up in the next
      // session never having been told its files were rolled back.
      const conversation = deps.findConversation(conversationId);
      if (conversation) {
        conversation.messages.push({
          role: 'user',
          content: undoNote(restored, deps.workspaceRoot),
          internal: true,
        });
        deps.persist(conversationId);
      }
      return restored;
    },
    async keep(): Promise<void> {
      const conversationId = deps.activeConversationId();
      await deps.checkpoints.keep(conversationId);
      dismiss(conversationId);
    },
    canUndo(): boolean {
      return deps.checkpoints.canUndo(deps.activeConversationId());
    },
  };
}
