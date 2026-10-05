/**
 * Text scrubbing for the progress surface.
 *
 * Extracted from `RemoteAgentProgress` because progress text arrives from three
 * untrusted places — a model-supplied tool name, a status line, a guard's
 * notice — and each needs a different rule before it can go into a chat
 * message. Keeping the rules here means the lifecycle owner cannot grow a
 * second, subtly different sanitizer.
 */

/** Tool names are model-supplied: keep the identifier, drop anything after it. */
const MAX_TOOL_NAME_CHARS = 80;

/**
 * Drops control characters that would break a Telegram message.
 *
 * A status line can carry a NUL or an escape from a tool's own output, and
 * Telegram rejects a message containing some of them — which, sent from inside
 * a progress tail, would strand the rest of that turn's updates. Tab, newline
 * and carriage return survive because progress text is deliberately multi-line.
 */
export function sanitize(value: string): string {
  let output = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) {
      output += character;
    }
  }
  return output;
}

/**
 * The leading identifier of a tool name, nothing more.
 *
 * `run_terminal` can be handed `rm -rf / --no-preserve-root`; echoing it into a
 * progress line would put a shell command on the user's phone as if Forge had
 * run it. Matching the identifier prefix also survives the argument lists that
 * used to make the bubble unreadable.
 */
export function sanitizeToolName(value: string): string {
  return (value.match(/^[a-zA-Z0-9_.:-]+/)?.[0] ?? '').slice(0, MAX_TOOL_NAME_CHARS);
}

/**
 * Keeps the *end* of a value, marked as truncated.
 *
 * Progress text is front-loaded with a headline the reader has already seen, so
 * when a line has to be cut the informative part is the tail — and the ellipsis
 * is what says the sentence did not end where it appears to.
 */
export function keepTail(value: string, maximum: number): string {
  return value.length <= maximum ? value : `…${value.slice(-(maximum - 1))}`;
}
