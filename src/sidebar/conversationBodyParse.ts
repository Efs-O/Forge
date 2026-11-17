/**
 * Parse one persisted conversation body, and keep the chat when the only bad
 * field is its compaction notes.
 *
 * A saved body is validated as a whole, so one oversized entry inside
 * `compaction` used to throw the entire chat away: on 2026-11-17 four
 * compacted chats were lost because `compaction.userMessages[0]` exceeded a
 * bound the writer had already raised, while the hundreds of messages next to
 * it were fine. `compaction` is the one field a reader may drop and still
 * load, because it is derived state — the next turn regenerates it, and a chat
 * that simply has no compaction is a normal, working chat. Every other field
 * is the transcript, the identity or the title, so a failure there still
 * rejects the body and the caller quarantines it as before.
 */

import { conversationPersistedSchema, type ConversationPersisted } from './sessionTypes';

/**
 * The result of validating one body. `issue` on a kept body is the message
 * from the parse that failed, kept so the caller's log line can name what was
 * wrong; `dropped` says which field (only ever `compaction`) was discarded to
 * make the rest load.
 */
export type BodyParse =
  | {
      ok: true;
      body: ConversationPersisted;
      dropped: 'compaction' | null;
      issue: string | null;
    }
  | { ok: false; issue: string };

/**
 * `conversationPersistedSchema` over the parsed JSON: accepted whole, or
 * accepted with `compaction` dropped, or rejected.
 *
 * Only `compaction` is ever dropped, and only when the body parses cleanly
 * without it — a body that is bad somewhere else is not rescued here, so an
 * invalid `messages` array, a missing `id` or a non-object stays rejected.
 */
export function parseConversationBody(json: unknown): BodyParse {
  const whole = conversationPersistedSchema.safeParse(json);
  if (whole.success) return { ok: true, body: whole.data, dropped: null, issue: null };
  if (isPlainObject(json) && 'compaction' in json) {
    const withoutCompaction: Record<string, unknown> = { ...json };
    delete withoutCompaction['compaction'];
    const rest = conversationPersistedSchema.safeParse(withoutCompaction);
    if (rest.success)
      return { ok: true, body: rest.data, dropped: 'compaction', issue: whole.error.message };
  }
  return { ok: false, issue: whole.error.message };
}

/** A JSON object, as opposed to an array or `null`, both of which are `typeof 'object'`. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
