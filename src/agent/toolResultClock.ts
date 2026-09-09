import type { ChatMessage } from '../llm/types';
import { localTimeOfDay } from '../util/localClock';

/**
 * Render each tool result's creation time into the model-facing prompt.
 *
 * The model has no clock of its own. Between rounds it learns the time only
 * from what a tool returned, and only `wait` and the background-exec tools
 * carried one — so on a slow local model its sense of "now" is as old as its
 * last call to one of those. In session 3c073ca7 a single round took 13.5
 * minutes, and the agent reasoned "it's now ~20:50, so I should wait until
 * 21:21" from a clock it had read at 20:46. The real time was 21:10 and the
 * rate limit it was waiting on had all but reset. It was not confused; it was
 * reading the freshest number it had.
 *
 * Two rules make this safe, and both matter:
 *
 * - The stamp is derived from `stampedAt`, fixed when the result was created,
 *   NOT from the clock at render time. A tool result that changed text between
 *   rounds would invalidate the KV cache from that point on every round; this
 *   one is byte-identical forever.
 * - It is applied to a model-facing copy only. The stored transcript, the
 *   sidebar, and `read_tool_result`'s exact ranges keep the raw result.
 *
 * Why not the system prompt: that is the cache's prefix, so a clock ticking
 * there re-evaluates the entire prompt every round — 363 seconds of prompt eval
 * on the turn above. A tool result is appended after everything already cached.
 * Keeping every round's stamp rather than only the newest is deliberate: it is
 * what lets the model see how long its own work has been taking.
 */
export function stampToolResultClocks(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== 'tool' || typeof message.stampedAt !== 'number') return message;
    const stamp = `\n\n[tool result produced at ${localTimeOfDay(new Date(message.stampedAt))} local]`;
    if (typeof message.content === 'string') {
      return { ...message, content: `${message.content}${stamp}` };
    }
    // Image/multipart results: append a text part rather than reshaping the array.
    if (Array.isArray(message.content)) {
      return { ...message, content: [...message.content, { type: 'text' as const, text: stamp }] };
    }
    return message;
  });
}
