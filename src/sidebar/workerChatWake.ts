import type { ForgeRequestOutcome } from './turnOutcome';
import type { MidTurnTellOrigin } from '../agent/MidTurnInbox';
import type { ConversationRuntime } from './sessionTypes';
import { getLogger } from '../util/logger';

const logger = getLogger();

export type ConversationSettledListener = (
  conversationId: string,
  outcome: ForgeRequestOutcome,
) => void | Promise<void>;

const conversationSettledListeners = new Set<ConversationSettledListener>();

/** Subscribe to the point where one conversation's full request chain settles. */
export function subscribeConversationSettled(listener: ConversationSettledListener): {
  dispose(): void;
} {
  conversationSettledListeners.add(listener);
  return { dispose: () => conversationSettledListeners.delete(listener) };
}

/** Notify every settled listener without allowing one observer to reject a send. */
export async function notifyConversationSettled(
  conversationId: string,
  outcome: ForgeRequestOutcome,
): Promise<void> {
  for (const listener of [...conversationSettledListeners]) {
    try {
      await listener(conversationId, outcome);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.error(`[SendPipeline] final outcome listener failed: ${detail}`);
    }
  }
}

const NOTICE_PREFIX = '[Forge notice] Worker chat "';
const NOTICE_MIDDLE = '" (';
const NOTICE_SUFFIX = '. Read it with message_chat view.';

function wakeText(worker: ConversationRuntime, outcome: 'completed' | 'failed'): string {
  const workerId = worker.id.slice(0, 80);
  const fixedLength =
    NOTICE_PREFIX.length +
    NOTICE_MIDDLE.length +
    workerId.length +
    NOTICE_SUFFIX.length +
    outcome.length +
    2;
  const title = worker.title.slice(0, Math.max(0, 299 - fixedLength));
  return `${NOTICE_PREFIX}${title}${NOTICE_MIDDLE}${workerId}) ${outcome}${NOTICE_SUFFIX}`;
}

/** Notify the chat that opened a worker when its complete send chain settles. */
export function createWorkerChatWake(deps: {
  openConversations: () => readonly ConversationRuntime[];
  routeInternal: (text: string, id: string, origin: MidTurnTellOrigin) => void;
  logDrop?: (message: string) => void;
}): ConversationSettledListener {
  return (conversationId, outcome) => {
    const conversations = deps.openConversations();
    const worker = conversations.find((conversation) => conversation.id === conversationId);
    if (!worker) return;
    const openerId = worker.opened_by;
    if (!openerId || (outcome.kind !== 'completed' && outcome.kind !== 'failed')) return;
    if (!conversations.some((conversation) => conversation.id === openerId)) {
      const message = `[worker-chat-wake] dropped worker ${worker.id}: opener ${openerId} is no longer open`;
      if (deps.logDrop) deps.logDrop(message);
      else logger.info(message);
      return;
    }
    // new_chat always creates a fresh id, so opener edges are acyclic; pending
    // wake coalescing and message_chat's send limit bound repeated supervision.
    deps.routeInternal(wakeText(worker, outcome.kind), openerId, {
      kind: 'worker-wake',
      workerId: worker.id,
    });
  };
}

/** Register the worker wake on the shared conversation-chain settled event. */
export function registerWorkerChatWake(deps: {
  openConversations: () => readonly ConversationRuntime[];
  routeInternal: (text: string, id: string, origin: MidTurnTellOrigin) => void;
  logDrop?: (message: string) => void;
}): { dispose(): void } {
  return subscribeConversationSettled(createWorkerChatWake(deps));
}
