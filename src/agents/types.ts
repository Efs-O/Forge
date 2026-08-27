/**
 * Shared types for the `provider: cli` external agent driver (docs/plans/CONFIG_OVERHAUL_PLAN.md
 * §2.4/§4 step 7). Forge spawns an already-logged-in CLI (Claude Code, Codex) as a
 * full-rights external agent using its own tools — Forge never injects its tool
 * registry or runs its own tool-calling loop for these.
 */

export type CliAgentName = 'claude' | 'codex';

/** Mirrors WorkerAccess ('read' | 'write') without depending on the workers/
 *  module — this driver is also used by ask_local_agent (no worker concept). */
export type CliAccessMode = 'read' | 'write' | 'full';

export interface CliAgentEvent {
  /** 'text': assistant text delta. 'status': concise tool-use status line, e.g. "[claude: Edit src/foo.ts]". */
  kind: 'text' | 'status';
  text: string;
}

export type CliAgentRunStatus = 'completed' | 'failed' | 'cancelled' | 'timed_out';

export interface CliAgentRunResult {
  status: CliAgentRunStatus;
  finalText: string;
  error?: string;
  /** Persistent Claude session / Codex thread identifier returned by the CLI. */
  sessionId?: string;
}

/** Mutation callbacks a per-CLI adapter uses while parsing one output line. */
export interface CliParseContext {
  emitText(text: string): void;
  emitStatus(text: string): void;
  setFinal(text: string): void;
  setError(text: string): void;
  setSessionId(sessionId: string): void;
}

export interface CliInvocationOptions {
  sessionId?: string;
  model?: string;
}

export interface CliAdapter {
  readonly name: CliAgentName;
  /** Build the CLI-specific argv (excluding the executable itself). */
  buildArgs(task: string, access: CliAccessMode, options?: CliInvocationOptions): string[];
  /** Parse one line of the CLI's streamed stdout (stream-json / JSONL). */
  handleLine(line: string, ctx: CliParseContext): void;
}

/**
 * The `cli` config field only tells us the executable (bare name or path) —
 * it does not declare which CLI it is. We infer it from the basename, since
 * scope is fixed to exactly these two CLIs (plan §2.4). Falls back to
 * 'claude' when ambiguous so a plain `claude`/absolute custom path resolves.
 */
export function inferCliAgentName(cli: string): CliAgentName {
  const base = cli
    .replace(/\\/g, '/')
    .split('/')
    .pop()!
    .replace(/\.(exe|cmd|bat|ps1)$/i, '')
    .toLowerCase();
  return base.includes('codex') ? 'codex' : 'claude';
}
