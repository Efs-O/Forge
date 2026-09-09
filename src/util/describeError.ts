/**
 * Turns a thrown value into the most specific sentence available, by walking
 * the `cause` chain.
 *
 * This exists because of `TypeError: fetch failed`. Node's undici reports every
 * transport fault under that one message — a refused connection, a reset
 * socket, a headers timeout, a dead port, a server that closed mid-stream — and
 * puts the only distinguishing information in `error.cause`. Reading `.message`
 * alone therefore collapses several unrelated faults into four words that name
 * none of them.
 *
 * That cost a real diagnosis. A turn died on 2026-09-09 with `fetch failed`
 * after llama-server had been up for nineteen hours and never restarted, which
 * ruled out the dead-port cause a previous fix had addressed — and left nothing
 * to identify what had actually happened, because the cause chain had already
 * been discarded at the point the message was built. It is the same shape as
 * llama-server answering a cut-off tool call and a malformed one with the same
 * HTTP 500: one string for two faults means neither can be acted on.
 *
 * Errors are joined outermost-first, so the familiar wrapper still leads and
 * the specific reason follows: `fetch failed: read ECONNRESET`.
 */

/** Depth guard. A cause chain this long is a bug in the thrower, not a report. */
const MAX_CAUSE_DEPTH = 5;

function messageOf(value: unknown): string {
  if (value instanceof Error) {
    // Node's system errors carry the useful part in `code` (ECONNRESET,
    // UND_ERR_HEADERS_TIMEOUT) while `message` is often the same generic text
    // as the parent, so name the code when it adds something.
    const code = (value as NodeJS.ErrnoException).code;
    const base = value.message.trim() || value.name;
    return code && !base.includes(code) ? `${base} (${code})` : base;
  }
  if (typeof value === 'string') return value.trim();
  return String(value);
}

/**
 * The message to show a user or write to a log. Never throws, and never returns
 * an empty string — an error that describes nothing is worse than its class
 * name.
 */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (
    let depth = 0;
    depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null;
    depth++
  ) {
    const message = messageOf(current);
    // A cause that merely repeats its parent adds nothing to read.
    if (message && !parts.includes(message) && !parts.some((part) => part.includes(message))) {
      parts.push(message);
    }
    current = current instanceof Error ? (current.cause as unknown) : undefined;
  }
  return parts.join(': ') || 'unknown error';
}

/**
 * Rebuilds an Error whose `message` carries the whole chain, preserving the
 * original as `cause` so nothing downstream loses it. Use at the boundary where
 * a transport error becomes something a person reads.
 */
export function withDescribedCause(error: unknown): Error {
  const described = describeError(error);
  if (error instanceof Error && error.message === described) return error;
  return new Error(described, { cause: error });
}
