import type { CheckpointStack } from '../checkpoint/CheckpointStack';
import type { HostToWebview } from './messageBridge';
import { checkpointReadyMessage } from './checkpointStats';

/** Repost the editor Keep/Undo affordance when a chat with pending changes returns. */
export function repostPendingCheckpoint(
  checkpoints: CheckpointStack,
  post: (message: HostToWebview) => void,
  conversationId: string,
): void {
  if (!checkpoints.canUndo(conversationId)) return;
  post(checkpointReadyMessage(checkpoints, conversationId));
}
