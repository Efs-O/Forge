/**
 * Shared ask_agent size policy and the required report-file handoff.
 *
 * 20,000, not the 6,000 this file used to carry: a delegation brief is routinely
 * that long (the 2026-11-02 chat c4dabce1 was refused three times running at
 * 7,012 / 6,373 / 6,155 characters before it got under the old ceiling), and the
 * ceiling is what decides the shape of the work — under it the sender has to
 * write a report file and send a path, over it it can send the brief itself.
 * Checked once, here, so the tool schema and this service cannot disagree about
 * which one a given message is.
 *
 * The transport, measured rather than assumed: a Claude ask travels as a file
 * (`writeQuestion`) or a peer frame, so its length costs nothing; a Codex ask
 * goes through `codex queue --message <text>` in the process argv, which is
 * inside the 32,767-character CreateProcess line for a real executable but not
 * for a `.cmd` wrapper run through cmd.exe — that path already refused a
 * multi-line message before this number moved, so the raise does not open it.
 */
export const MAX_QUESTION_CHARS = 20000;

export function questionSizeRefusal(detail: string): string {
  return (
    `ask_agent: ${detail} Do not trim and resend. Write the full report to ` +
    '`.forge/tmp/<name>.md`, then send the path plus at most 1,500 characters. The hard ' +
    `question ceiling is ${MAX_QUESTION_CHARS} characters; it overrides earlier instructions ` +
    'about report content.'
  );
}
