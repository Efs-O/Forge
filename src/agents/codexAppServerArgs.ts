/**
 * How Forge launches `codex app-server`.
 *
 * Codex runs unrestricted here, matching how the user runs `codex` directly in
 * a terminal: Forge launches the process, Codex owns its own tools, loop and
 * sandbox. The rollback boundary is the workspace checkpoint Forge takes before
 * the CLI starts (see CliChatRunner), not a narrowed sandbox.
 */

export interface CodexAppServerLaunch {
  executable: string;
  argsPrefix?: readonly string[];
  /** Reasoning effort (`agent_bus.codex_effort`). Unset: no `-c` flag, the
   *  CLI's own default applies. */
  effort?: string;
}

export function codexAppServerArgs(launch: CodexAppServerLaunch): string[] {
  return [
    ...(launch.argsPrefix ?? []),
    'app-server',
    '--stdio',
    '-c',
    'analytics.enabled=false',
    // Applied to the Forge-owned app-server process as well as the thread so a
    // persisted local Codex setting cannot narrow a Forge chat either.
    '-c',
    'sandbox_mode="danger-full-access"',
    '-c',
    'approval_policy="never"',
    ...(launch.effort ? ['-c', `model_reasoning_effort="${launch.effort}"`] : []),
  ];
}

/** Parameters for `thread/start`, mirroring the process-level sandbox. */
export function codexThreadStartParams(cwd: string, model?: string): Record<string, unknown> {
  return {
    cwd,
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    ephemeral: false,
    ...(model ? { model } : {}),
  };
}

/**
 * Parameters for `thread/resume`. A resumed thread otherwise keeps the
 * model/effort it was created with, so `agent_bus.codex_model`/`codex_effort`
 * have to be re-applied here — verified 2026-10-03 against codex-cli 0.155.1:
 * a thread created on `gpt-5.6-sol`/`medium` runs the next turn on
 * `gpt-6-luna`/`xhigh` when resumed with these params, and a later plain
 * resume keeps them. `config` on `thread/resume` is NOT experimental-gated,
 * unlike `thread/settings/update` (which needs `experimentalApi` and so is
 * unusable here). No fallback on rejection: a Codex that stops accepting
 * these overrides must fail visibly rather than silently keep the old model.
 * See docs/CODEX_MODEL_SELECTION.md.
 */
export function codexThreadResumeParams(
  threadId: string,
  model?: string,
  effort?: string,
): Record<string, unknown> {
  return {
    threadId,
    ...(model ? { model } : {}),
    ...(effort ? { config: { model_reasoning_effort: effort } } : {}),
  };
}
