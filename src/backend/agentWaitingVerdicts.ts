import type { WaitingVerdict } from '../agentMesh/verdictArtifact';
import { sendJson } from './controlHttp';
import type { AgentRoutesDeps } from './agentRoutesDeps';

/**
 * How a window hands a session the answers that are waiting for it.
 *
 * The window knows the list (`waitingVerdictsForSession`); the session has to
 * see it, and the only channel is the response the session's own request
 * already gets. One line per waiting answer, appended to that response:
 *
 *     WAITING_VERDICT\t<exchangeId>\t<chat label>
 *
 * Appended after the body, whether the body was JSON or text. `forge.sh` is the
 * only client of these routes, and one format for every route beats one field
 * per response shape: the client strips the same prefix either way, and an agent
 * parsing `say`'s JSON keeps reading exactly the JSON it read before. The
 * client — not the server — writes the human sentence, because only the client
 * knows the `<name>` the caller typed.
 *
 * Only a success response carries the trailer. A 4xx body stays the error
 * message the route chose, so a refusal cannot grow a second message nobody
 * asked for.
 */
export const WAITING_VERDICT_FIELD = 'WAITING_VERDICT';

/** The trailer for these answers: `''` when there is none to announce, so a
 *  window with nothing waiting answers byte-identically to today. */
export function waitingVerdictTrailer(notices: readonly WaitingVerdict[]): string {
  if (notices.length === 0) return '';
  return `\n${notices
    .map((notice) => `${WAITING_VERDICT_FIELD}\t${notice.exchangeId}\t${notice.chatLabel}`)
    .join('\n')}`;
}

/** Text body plus the trailer — what `sendText` then terminates with a newline. */
export function appendWaitingVerdictTrailer(
  body: string,
  notices: readonly WaitingVerdict[],
): string {
  return `${body}${waitingVerdictTrailer(notices)}`;
}

/** JSON body plus the trailer. With nothing waiting this is `sendJson` itself,
 *  so the bytes of a clean response do not change. */
export function sendJsonWithWaitingVerdicts(
  res: Parameters<typeof sendJson>[0],
  status: number,
  body: unknown,
  notices: readonly WaitingVerdict[],
): void {
  const trailer = waitingVerdictTrailer(notices);
  if (trailer === '') return sendJson(res, status, body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(`${JSON.stringify(body)}${trailer}`);
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
