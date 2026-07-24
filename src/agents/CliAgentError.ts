/** Structured error for CLI agent driver failures — resolution, spawn, and
 *  exit-code failures all surface through this so callers can report exit
 *  code + stderr tail verbatim (CLAUDE.md: no swallowed errors). */
export class CliAgentError extends Error {
  constructor(
    message: string,
    readonly exitCode?: number | null,
    readonly stderrTail?: string,
  ) {
    super(message);
    this.name = 'CliAgentError';
  }
}
