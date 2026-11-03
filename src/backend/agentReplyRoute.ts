/**
 * `POST /agent/reply` — the answer to a question Forge is waiting on.
 *
 * Extracted from `agentRoutes.ts`, which is at the 500-line gate, because what
 * this route answers is a decision of its own and not of the router: it has to
 * say whether anything is still waiting to read the reply, not only that the
 * request was well formed. Audit F7 is the bug this makes impossible to repeat:
 * `reply` answered `delivered: true` for any well-formed id, so a caller holding
 * an answer for an exchange that had already ended believed Forge had received
 * it, and the file it wrote waited for the 24 h sweep instead of an answer.
 */

import { BUS_ID_PATTERN, questionIsWaiting, writeReply, type BusPaths } from '../agentBus/agentBus';
import { AgentRouteHttpError, requireText, type AgentRouteFields } from './agentRouteFields';

/** An answer may be longer than a new message: it is what Forge asked for. */
const MAX_REPLY_CHARS = 32_000;

/**
 * The reply answer. `delivered: true` only while the question file is still
 * there: that file is the record that someone is polling for the answer,
 * written when the ask starts and withdrawn the moment it ends (answered, timed
 * out or aborted), and swept after 24 h. A reply for a question that has ended
 * is accepted but not written — nothing would read it, and the ledger row for
 * the reply outbox says a finished exchange leaves nothing behind. 200 and not
 * 404 because `forge.sh reply` writes the outbox file itself whenever the
 * endpoint refuses a request, so a 404 would leave the same unread file behind
 * with a worse message.
 */
export function handleAgentReplyRoute(options: { fields: AgentRouteFields; paths: BusPaths }): {
  status: number;
  body: Record<string, unknown>;
} {
  const { fields, paths } = options;
  const id = typeof fields['id'] === 'string' ? fields['id'] : '';
  if (!BUS_ID_PATTERN.test(id)) throw new AgentRouteHttpError(400, 'id must be the question id');
  const text = requireText(fields, MAX_REPLY_CHARS);
  if (!questionIsWaiting(paths, id)) {
    return {
      status: 200,
      body: {
        accepted: true,
        live: false,
        note: `Forge is not waiting on "${id}": that question was answered, withdrawn, or swept after 24 h. Nothing will read this reply - send it again as a message.`,
      },
    };
  }
  writeReply(paths, id, text);
  return { status: 200, body: { delivered: true } };
}
