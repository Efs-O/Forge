/** Shared ask_agent size policy and the required report-file handoff. */
export const MAX_QUESTION_CHARS = 6000;

export function questionSizeRefusal(detail: string): string {
  return (
    `ask_agent: ${detail} Do not trim and resend. Write the full report to ` +
    '`.forge/tmp/<name>.md`, then send the path plus at most 1,500 characters. The hard ' +
    `question ceiling is ${MAX_QUESTION_CHARS} characters; it overrides earlier instructions ` +
    'about report content.'
  );
}
