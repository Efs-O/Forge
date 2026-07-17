import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';
import {
  checkShellOperators,
  checkPowerShellBan,
  detectTestRunner,
  ExecCommandError,
  formatExecCommandOutput,
  formatOutput,
  getWorkspaceRoot,
  guardExec,
  MAX_OUTPUT_CHARS,
  resolveExecCwd,
  spawnAndWait,
} from './execHelpers';
import { checkDenyList, getBuiltinDenyList } from './DenyList';

// ── run_terminal ───────────────────────────────────────────────────────────────

export function makeRunTerminalTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'run_terminal',
        description:
          'Paste a command into the Forge terminal panel. The user must press Enter to run it — the command is NEVER executed automatically.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to paste.' },
            cwd: {
              type: 'string',
              description: 'Working directory (absolute or workspace-relative). Optional.',
            },
          },
          required: ['command'],
          additionalProperties: false,
        },
      },
    },
    permission: 'terminal',
    handler: async (args) => {
      const command = args['command'] as string;
      const cwd = resolveExecCwd(args['cwd'] as string | undefined);

      const denied = checkDenyList(command, [], getBuiltinDenyList());
      if (denied) {
        throw new Error(
          `run_terminal: command matches denylist pattern "${denied.description}" — paste refused.`,
        );
      }

      const terminal = vscode.window.createTerminal({ name: 'Forge', cwd });
      terminal.show(false); // show but don't steal focus

      // NEVER pass `addNewLine: true` — user must press Enter intentionally
      terminal.sendText(command, false);

      return 'Command pasted to terminal — press Enter to run.';
    },
  };
}

// ── exec_command ───────────────────────────────────────────────────────────────

export function makeExecCommandTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'exec_command',
        description:
          'Execute a binary directly (no shell). Requires user confirmation. Shell operators in args are banned — split into separate calls instead.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Binary to run (no shell).' },
            args: { type: 'array', items: { type: 'string' }, description: 'Arguments array.' },
            cwd: { type: 'string', description: 'Working directory. Optional.' },
            timeout_ms: { type: 'integer', description: 'Timeout in ms. Default 30000.' },
          },
          required: ['command', 'args'],
          additionalProperties: false,
        },
      },
    },
    permission: 'headless',
    handler: async (args) => {
      const command = args['command'] as string;
      const cmdArgs = (args['args'] as string[]) ?? [];
      const cwd = resolveExecCwd(args['cwd'] as string | undefined);
      const timeoutMs = (args['timeout_ms'] as number | undefined) ?? 30_000;

      try {
        checkShellOperators(cmdArgs);
      } catch (error) {
        throw new ExecCommandError(
          'invalid_shell_syntax',
          command,
          error instanceof Error ? error.message : String(error),
        );
      }
      try {
        checkPowerShellBan(command, cmdArgs);
        guardExec(command, cmdArgs);
      } catch (error) {
        throw new ExecCommandError(
          'policy_refusal',
          command,
          error instanceof Error ? error.message : String(error),
        );
      }

      const result = await spawnAndWait(command, cmdArgs, cwd, timeoutMs);
      return formatExecCommandOutput(command, result);
    },
  };
}

// ── run_tests ──────────────────────────────────────────────────────────────────

export function makeRunTestsTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'run_tests',
        description:
          'Run the project test suite. Auto-detects vitest, jest, or mocha via package.json.',
        parameters: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description: 'File or test name pattern to filter. Optional.',
            },
            reporter: { type: 'string', description: 'Reporter name (e.g. verbose). Optional.' },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    permission: 'headless',
    handler: async (args) => {
      const root = getWorkspaceRoot();
      const runner = detectTestRunner(root);
      const cmdArgs = [...runner.baseArgs];

      const pattern = args['pattern'] as string | undefined;
      const reporter = args['reporter'] as string | undefined;

      if (pattern) cmdArgs.push(pattern);
      if (reporter) cmdArgs.push('--reporter', reporter);

      guardExec(runner.command, cmdArgs);

      const result = await spawnAndWait(runner.command, cmdArgs, root, 60_000);
      return formatOutput(result);
    },
  };
}

// ── run_build ──────────────────────────────────────────────────────────────────

export function makeRunBuildTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'run_build',
        description:
          'Run an npm script (default: "build"). Reads package.json to verify the script exists.',
        parameters: {
          type: 'object',
          properties: {
            script: { type: 'string', description: 'npm script name. Default "build".' },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    permission: 'headless',
    handler: async (args) => {
      const root = getWorkspaceRoot();
      const script = (args['script'] as string | undefined) ?? 'build';

      // Verify script exists in package.json
      const pkgPath = path.join(root, 'package.json');
      if (!fs.existsSync(pkgPath)) {
        throw new Error('run_build: no package.json found in workspace root');
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- package.json is untyped
      let pkg: any;
      try {
        pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      } catch (err) {
        throw new Error(`run_build: cannot parse package.json — ${(err as Error).message}`);
      }

      const scripts: Record<string, string> = pkg.scripts ?? {};
      if (!scripts[script]) {
        throw new Error(`run_build: script "${script}" not found in package.json`);
      }

      const cmdArgs = ['run', script];
      guardExec('npm', cmdArgs);

      const result = await spawnAndWait('npm', cmdArgs, root, 120_000);
      const out = result.stdout.slice(0, MAX_OUTPUT_CHARS);
      let formatted = out;
      if (result.stderr) formatted += `\n[stderr]\n${result.stderr.slice(0, MAX_OUTPUT_CHARS)}`;
      formatted += `\n[exit code: ${result.exitCode ?? 'null'}]`;
      return formatted;
    },
  };
}
