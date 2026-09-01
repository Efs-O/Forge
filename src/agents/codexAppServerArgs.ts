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
