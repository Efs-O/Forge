/**
 * How Forge launches `codex app-server`.
 *
 * Split out of `CodexAppServerSession` because these flags are a security
 * boundary, not startup trivia: they are what keeps a Forge chat inside its
 * workspace regardless of the user's own persisted Codex settings.
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
    // Apply the policy to the Forge-owned app-server process as well as the
    // thread. This prevents a persisted local Codex setting from widening
    // a Forge chat beyond its workspace boundary.
    '-c',
    'sandbox_mode="workspace-write"',
    '-c',
    'approval_policy="untrusted"',
    '-c',
    'sandbox_workspace_write.network_access=false',
  ];
}

/** Parameters for `thread/start`, mirroring the process-level sandbox. */
export function codexThreadStartParams(cwd: string, model?: string): Record<string, unknown> {
  return {
    cwd,
    approvalPolicy: 'untrusted',
    sandbox: 'workspace-write',
    ephemeral: false,
    ...(model ? { model } : {}),
  };
}
