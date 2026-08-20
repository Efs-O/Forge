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
  guardExec,
  MAX_OUTPUT_CHARS,
  MAX_EXEC_OUTPUT_LINES,
  parseExecOutputOptions,
  resolveExecCwd,
  spawnAndWait,
} from './execHelpers';
import {
  canonicalizeExecCommand,
  describeShellBuiltin,
  resolveExecInvocation,
  resolvePackageRunnerInvocation,
} from './execProgramResolver';
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
          `run_terminal: command matches denylist pattern "${denied.description}" — paste refused.` +
            (denied.alternative ? ` ${denied.alternative}` : ''),
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
          'Execute a binary directly (no shell). "npm" and "npx" work as-is on every platform — do not wrap them in cmd or add .cmd. Shell builtins (dir, echo, type) are not programs and will not run; use list_directory, write_file, and read_file instead. Shell operators in args and dangerous commands are refused. Use tail_lines, head_lines, max_output_chars, or output_stream to shape returned output instead of piping.',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description:
                'Executable to run, with no shell. Bare "npm" and "npx" are resolved for you on Windows.',
            },
            args: { type: 'array', items: { type: 'string' }, description: 'Arguments array.' },
            cwd: { type: 'string', description: 'Working directory. Optional.' },
            timeout_ms: { type: 'integer', description: 'Timeout in ms. Default 30000.' },
            tail_lines: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_EXEC_OUTPUT_LINES,
              description: 'Return only the final N lines from each selected output stream.',
            },
            head_lines: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_EXEC_OUTPUT_LINES,
              description:
                'Return only the first N lines from each selected output stream. Cannot be used with tail_lines.',
            },
            max_output_chars: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_OUTPUT_CHARS,
              description: 'Maximum returned characters per selected output stream. Default 10000.',
            },
            output_stream: {
              type: 'string',
              enum: ['both', 'stdout', 'stderr'],
              description: 'Which output stream to return. Default both.',
            },
          },
          required: ['command', 'args'],
          additionalProperties: false,
        },
      },
    },
    permission: 'headless',
    handler: async (args) => {
      // `npm.cmd` and `npm` are one program, and the denylist recognises the
      // bare spelling only — collapse them BEFORE any guard sees the command.
      const command = canonicalizeExecCommand(args['command'] as string);
      const cmdArgs = (args['args'] as string[]) ?? [];
      const outputOptions = parseExecOutputOptions(args);
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
        const denied = checkDenyList(command, cmdArgs, getBuiltinDenyList());
        if (denied) {
          throw new Error(
            `exec_command: command matches denylist pattern "${denied.description}" — execution refused.` +
              (denied.alternative ? ` ${denied.alternative}` : ''),
          );
        }
        checkPowerShellBan(command, cmdArgs);
        guardExec(command, cmdArgs);
      } catch (error) {
        throw new ExecCommandError(
          'policy_refusal',
          command,
          error instanceof Error ? error.message : String(error),
        );
      }

      // Guards ran against the canonical name, so the denylist saw `npm`, not
      // the node.exe it resolves to. Only the spawn sees the translation.
      let spawned;
      try {
        spawned = resolveExecInvocation(command, cmdArgs);
      } catch (error) {
        throw new ExecCommandError(
          'missing_executable',
          command,
          error instanceof Error ? error.message : String(error),
        );
      }

      try {
        const result = await spawnAndWait(spawned.command, spawned.args, cwd, timeoutMs);
        return formatExecCommandOutput(command, result, outputOptions);
      } catch (error) {
        // A cmd.exe builtin has no executable image, so spawn reports it
        // missing — true, but useless. Say which tool replaces it.
        const alternative = describeShellBuiltin(command);
        if (
          alternative &&
          error instanceof ExecCommandError &&
          error.kind === 'missing_executable'
        ) {
          throw new ExecCommandError(
            'missing_executable',
            command,
            `"${command}" is a shell builtin, not a program, and exec_command runs without a shell. ${alternative}`,
          );
        }
        throw error;
      }
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
            cwd: {
              type: 'string',
              description:
                'Project directory to run in, relative to the workspace root (or absolute). Defaults to the workspace root — set it when the project is a subdirectory, e.g. "threejs-game-prompt".',
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    permission: 'headless',
    handler: async (args) => {
      // Was hardcoded to the workspace root, so in a workspace holding several
      // projects it looked for a package.json that was never there and failed
      // with a bare ENOENT naming a path nobody had chosen.
      const root = resolveExecCwd(args['cwd'] as string | undefined);
      const runner = detectTestRunner(root);
      const cmdArgs = [...runner.baseArgs];

      const pattern = args['pattern'] as string | undefined;
      const reporter = args['reporter'] as string | undefined;

      if (pattern) cmdArgs.push(pattern);
      if (reporter) cmdArgs.push('--reporter', reporter);

      guardExec(runner.command, cmdArgs);

      const invocation = resolvePackageRunnerInvocation(runner.command as 'npm' | 'npx');
      const result = await spawnAndWait(
        invocation.command,
        [...invocation.argsPrefix, ...cmdArgs],
        root,
        60_000,
      );
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
            cwd: {
              type: 'string',
              description:
                'Project directory to run in, relative to the workspace root (or absolute). Defaults to the workspace root — set it when the project is a subdirectory, e.g. "threejs-game-prompt".',
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    permission: 'headless',
    handler: async (args) => {
      const root = resolveExecCwd(args['cwd'] as string | undefined);
      const script = (args['script'] as string | undefined) ?? 'build';

      // Verify script exists in package.json
      const pkgPath = path.join(root, 'package.json');
      if (!fs.existsSync(pkgPath)) {
        throw new Error(
          `run_build: no package.json in ${root}. Pass cwd if the project is a subdirectory.`,
        );
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

      const invocation = resolvePackageRunnerInvocation('npm');
      const result = await spawnAndWait(
        invocation.command,
        [...invocation.argsPrefix, ...cmdArgs],
        root,
        120_000,
      );
      const out = result.stdout.slice(0, MAX_OUTPUT_CHARS);
      let formatted = out;
      if (result.stderr) formatted += `\n[stderr]\n${result.stderr.slice(0, MAX_OUTPUT_CHARS)}`;
      formatted += `\n[exit code: ${result.exitCode ?? 'null'}]`;
      return formatted;
    },
  };
}
