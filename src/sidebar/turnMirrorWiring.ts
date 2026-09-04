import type { ConversationRuntime } from './sessionTypes';
import type { HostActivityEvent } from './HostActivity';
import type { SidebarProviderEvents } from './AgentLoop';

/** Telegram's own cap is 4096; leave room for the prefix and an ellipsis. */
const MAX_MIRRORED_CHARS = 3_500;

export interface TurnMirrorWiring {
  lookup: (conversationId: string) => ConversationRuntime | undefined;
  emit: (event: HostActivityEvent) => void;
}

/**
 * Echo a finished turn's answer to the chats bound to its conversation.
 *
 * Decorates `onGenerationFinished` the way wireSessionTimer does, for the same
 * reason: the event already fires at exactly the right moment and carries the
 * conversationId, so the alternative is a second event firing beside it.
 *
 * This fires for EVERY turn, including ones a remote chat asked for.
 * De-duplication is not attempted here on purpose — the fact that decides it
 * is "does a remote progress message already own this turn", which only
 * RemoteAgentProgress knows. RemoteController.mirrorTurn asks it there.
 * Guessing at origin from this side would mean threading a flag through the
 * whole turn path to answer the same question worse.
 */
export function wireTurnMirror(events: SidebarProviderEvents, deps: TurnMirrorWiring): void {
  const original = events.onGenerationFinished;
  events.onGenerationFinished = (modelName, conversationId, finalText) => {
    original?.(modelName, conversationId, finalText);
    if (conversationId === undefined) return;
    // The provider already has the exact final answer at this point. Reading
    // the transcript here was racy around cold backend startup/restart: a
    // session sync or a continuation could make the callback see a different
    // tail even though the turn had just completed successfully.
    const text = finalText?.trim() || finalAnswer(deps.lookup(conversationId));
    if (text) deps.emit({ text, conversationId, kind: 'turn' });
  };
}

/**
 * The last assistant text in the transcript.
 *
 * Walks backwards rather than reading the final element: a turn ends with tool
 * rows after the answer often enough that indexing the end would mirror an
 * empty string. A turn that produced only tool calls has no answer to send,
 * and returns undefined rather than an empty message.
 */
function finalAnswer(conv: ConversationRuntime | undefined): string | undefined {
  if (!conv) return undefined;
  for (let index = conv.messages.length - 1; index >= 0; index -= 1) {
    const message = conv.messages[index]!;
    if (message.role === 'user') return undefined;
    if (message.role !== 'assistant' || typeof message.content !== 'string') continue;
    const text = message.content.trim();
    if (!text) continue;
    return text.length > MAX_MIRRORED_CHARS
      ? `${text.slice(0, MAX_MIRRORED_CHARS)}\n\n… (truncated; see the Forge window)`
      : text;
  }
  return undefined;
}
