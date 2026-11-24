import type { WaitingVerdict } from '../agentMesh/verdictArtifact';
import { sendJson } from './controlHttp';
import type { AgentRoutesDeps } from './agentRoutesDeps';

/**
 * How a window hands a session the answers that are waiting for it.
 *
 * The window knows the list (`waitingVerdictsForSession`); the session has to
 * see it, and the only channel is the response the session's own request
 * already gets. Two forms, because the routes answer in two shapes:
 *
 *   - a JSON body grows one field, `waiting_verdicts`, and stays valid JSON:
 *     `{"queued":1,"id":"m1","waiting_verdicts":[{"exchangeId":"…","chat":"…"}]}`
 *     The field is absent when nothing waits, so a clean response is byte-for-byte
 *     what it was before, and every client of the control server keeps parsing
 *     the same JSON (CLAUDE.md: the API is the compat contract).
 *   - a text body (`status`, `view`, `read-verdict`) grows one line per answer:
 *     `WAITING_VERDICT<TAB><exchangeId><TAB><chat label>`
 *     Those bodies are `text/plain` and `text/markdown`, never JSON — no client
 *     could have parsed them as JSON, so a line after them breaks nothing, and
 *     `status` is the route `forge.sh wait` polls. A field would mean wrapping a
 *     markdown verdict in JSON, which is a different contract.
 *
 * Only a success response carries either. A 4xx body stays the error the route
 * chose, so a refusal cannot grow a second message nobody asked for.
 *
 * The client — not the server — writes the human sentence, because only the
 * client knows the `<name>` the caller typed.
 */
export const WAITING_VERDICT_TRAILER = 'WAITING_VERDICT';

/** The JSON field, present only when the list is non-empty. */
export const WAITING_VERDICTS_FIELD = 'waiting_verdicts';

/** The trailer for these answers: `''` when there is none to announce, so a
 *  window with nothing waiting answers byte-identically to today. */
export function waitingVerdictTrailer(notices: readonly WaitingVerdict[]): string {
  if (notices.length === 0) return '';
  return `\n${notices
    .map((notice) => `${WAITING_VERDICT_TRAILER}\t${notice.exchangeId}\t${notice.chatLabel}`)
    .join('\n')}`;
}

/** Text body plus the trailer — what `sendText` then terminates with a newline. */
export function appendWaitingVerdictTrailer(
  body: string,
  notices: readonly WaitingVerdict[],
): string {
  return `${body}${waitingVerdictTrailer(notices)}`;
}

/** One waiting answer as it travels in the JSON field: the two things the
 *  client needs to print its sentence — which exchange to read, and which chat
 *  it came from. Key order is the order `forge.sh` scans for, so a change here
 *  is a change there (`WaitingVerdicts.test.ts` pins both). */
export interface WaitingVerdictNotice {
  exchangeId: string;
  chat: string;
}

/** The field's value, in the order the answers were found (oldest first). */
export function waitingVerdictNotices(notices: readonly WaitingVerdict[]): WaitingVerdictNotice[] {
  return notices.map((notice) => ({ exchangeId: notice.exchangeId, chat: notice.chatLabel }));
}

/** A body `sendJson` can grow a field on: an object, not an array or a scalar. */
function isJsonObject(body: unknown): body is Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body);
}

/**
 * JSON body plus the waiting list as one field. With nothing waiting this is
 * `sendJson` itself, so the bytes of a clean response do not change. A body
 * that is not an object gets no field rather than a reshaped body: the route
 * that answers that way is not this helper's to redesign.
 */
export function sendJsonWithWaitingVerdicts(
  res: Parameters<typeof sendJson>[0],
  status: number,
  body: unknown,
  notices: readonly WaitingVerdict[],
): void {
  if (notices.length === 0 || !isJsonObject(body)) return sendJson(res, status, body);
  sendJson(res, status, {
    ...body,
    [WAITING_VERDICTS_FIELD]: waitingVerdictNotices(notices),
  });
}

/**
 * The answers to announce for this request's sender, and the one rule that
 * decides it: no session identity, nothing to announce. A bare `from` name is
 * not an identity — three Claude sessions can share one name, and telling the
 * wrong one about an answer it cannot read is worse than silence.
 */
export function noticesForSender(
  waitingVerdicts: AgentRoutesDeps['waitingVerdicts'],
  senderSessionId: string | undefined,
): WaitingVerdict[] {
  if (!waitingVerdicts || senderSessionId === undefined) return [];
  return waitingVerdicts(senderSessionId);
}
