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
  MAX_EXEC_STORED_CHARS,
  parseExecOutputOptions,
  resolveExecCwd,
  spawnAndWait,
} from './execHelpers';
import {
  canonicalizeExecCommand,
  describeShellBuiltin,
  describeWrongPlatformProgram,
  resolveExecInvocation,
  resolvePackageRunnerInvocation,
} from './execProgramResolver';
import { validateExecEnv } from './execEnvPolicy';
import { checkDenyList, getBuiltinDenyList } from './DenyList';
import { backgroundExecutionManager } from './BackgroundExecutionManager';
import { formatBackgroundObservation } from './backgroundExecutionTools';
import { terminalCommandTracker } from './TerminalCommandTracker';

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
    handler: async (args, context) => {
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
      terminalCommandTracker.trackPastedCommand(terminal, command, cwd, context?.conversationId);
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
          'Run an executable directly without a shell; pass args separately. npm/npx work cross-platform. Shell builtins, operators, and dangerous commands are refused. Use the output options instead of pipes; use background=true with monitor_execution for long jobs.',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'Executable name or path. Bare npm/npx are resolved on Windows.',
            },
            args: { type: 'array', items: { type: 'string' }, description: 'Arguments array.' },
            cwd: { type: 'string', description: 'Working directory. Optional.' },
            env: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description:
                'Optional environment variables for the process. A small, validated set — '
                + 'dangerous names (NODE_OPTIONS, PATH, LD_PRELOAD, …) are refused. '
                + 'Use for CLIs that need an env var (e.g. ELECTRON_RUN_AS_NODE).',
            },
            timeout_ms: {
              type: 'integer',
              description:
                'Deadline in ms (foreground default 30000; background has none unless set).',
            },
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
              description:
                'Maximum returned characters per selected output stream, for asking for LESS ' +
                'than the default. Omitted: the whole stream is returned, capped at ' +
                `${String(MAX_EXEC_STORED_CHARS)} characters. Output past the applied bound is ` +
                'dropped and cannot be recovered.',
            },
            output_stream: {
              type: 'string',
              enum: ['both', 'stdout', 'stderr'],
              description: 'Which output stream to return. Default both.',
            },
            background: {
              type: 'boolean',
              description:
                'Start the process without waiting for it. Returns an execution_id for monitor_execution.',
            },
          },
          required: ['command', 'args'],
          additionalProperties: false,
        },
      },
    },
    permission: 'headless',
    handler: async (args, context) => {
      // `npm.cmd` and `npm` are one program, and the denylist recognises the
      // bare spelling only — collapse them BEFORE any guard sees the command.
      const command = canonicalizeExecCommand(args['command'] as string);
      const cmdArgs = (args['args'] as string[]) ?? [];
      const outputOptions = parseExecOutputOptions(args);
      const cwd = resolveExecCwd(args['cwd'] as string | undefined);
      const requestedTimeoutMs = args['timeout_ms'] as number | undefined;
      const timeoutMs = requestedTimeoutMs ?? 30_000;

      try {
        checkShellOperators(cmdArgs);
      } catch (error) {
        throw new ExecCommandError(
          'invalid_shell_syntax',
          command,
          error instanceof Error ? error.message : String(error),
        );
      }
      // Validate the env BEFORE any guard/spawn. A rejected var is a policy
      // refusal, not a spawn failure — the model must not be told the program
      // is missing when the real problem is a blocked variable name.
      const envCheck = validateExecEnv(args['env'] as Record<string, unknown> | undefined);
      if (!envCheck.ok) {
        throw new ExecCommandError('policy_refusal', command, envCheck.error ?? 'invalid env');
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
        // Before the spawn, not after: this command would start successfully
        // and fail on its own terms, so there is no error path to improve.
        const wrongProgram = describeWrongPlatformProgram(command, cmdArgs);
        if (wrongProgram) throw new Error(wrongProgram);
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
        if (args['background'] === true) {
          const started = backgroundExecutionManager.start({
            command: spawned.command,
            args: spawned.args,
            cwd,
            timeoutMs: requestedTimeoutMs,
            env: envCheck.env,
          });
          // spawn reports a failed launch on the next tick, so observing
          // immediately would report "running" for a process already dead.
          await new Promise((resolve) => setImmediate(resolve));
          const observation = await backgroundExecutionManager.observe(started.id, 0, 0, 0);
          return formatBackgroundObservation(observation, 0, outputOptions);
        }
        const result = await spawnAndWait(
          spawned.command,
          spawned.args,
          cwd,
          timeoutMs,
          envCheck.env,
          context?.abortSignal,
        );
        return formatExecCommandOutput(command, result, outputOptions);
      } catch (error) {
        // spawn reports a cmd.exe builtin and a genuinely absent program the
        // same way: missing. True, and useless — a bare ENOENT names nothing
        // the model could use instead, so it concludes the capability is gone.
        const alternative = describeShellBuiltin(command);
        if (
          alternative &&
          error instanceof ExecCommandError &&
          error.kind === 'missing_executable'
        ) {
          throw new ExecCommandError(
            'missing_executable',
            command,
            `"${command}" is not available here: exec_command runs without a shell, ` +
              `so shell builtins have no executable image and Unix utilities are not on ` +
              `this PATH. ${alternative}`,
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
    handler: async (args, context) => {
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
        {},
        context?.abortSignal,
      );
      return formatOutput(result);
    },
  };
}

// ── run_build ──────────────────────────────────────────────────────────────────

/** Foreground ceiling. Anything slower must be started with background: true. */
const RUN_BUILD_TIMEOUT_MS = 120_000;

export function makeRunBuildTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'run_build',
        description:
          'Run an npm script (default: "build"). Reads package.json to verify the script exists. ' +
          'Foreground runs are capped at 2 minutes — pass background=true for a script that takes ' +
          'longer (release builds, packaging) and poll it with monitor_execution.',
        parameters: {
          type: 'object',
          properties: {
            script: { type: 'string', description: 'npm script name. Default "build".' },
            cwd: {
              type: 'string',
              description:
                'Project directory to run in, relative to the workspace root (or absolute). Defaults to the workspace root — set it when the project is a subdirectory, e.g. "threejs-game-prompt".',
            },
            background: {
              type: 'boolean',
              description:
                'Start the script without waiting for it. Returns an execution_id for monitor_execution. Required for anything over 2 minutes.',
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    permission: 'headless',
    handler: async (args, context) => {
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
      const command = invocation.command;
      const spawnArgs = [...invocation.argsPrefix, ...cmdArgs];

      if (args['background'] === true) {
        const started = backgroundExecutionManager.start({ command, args: spawnArgs, cwd: root });
        // Same reason as exec_command: a failed launch is reported on the next
        // tick, so observing immediately would call a dead process "running".
        await new Promise((resolve) => setImmediate(resolve));
        const observation = await backgroundExecutionManager.observe(started.id, 0, 0, 0);
        return formatBackgroundObservation(observation, 0, {});
      }

      let result;
      try {
        result = await spawnAndWait(
          command,
          spawnArgs,
          root,
          RUN_BUILD_TIMEOUT_MS,
          {},
          context?.abortSignal,
        );
      } catch (error) {
        // A bare "process timed out after 120000ms" taught the agent nothing:
        // `npm run package` takes ~3 minutes here, so this call could NEVER
        // succeed, and the retry that does work had to be guessed. An audited
        // session burned a turn and two minutes on exactly that. Name the way
        // out in the failure that blocks it.
        if (error instanceof ExecCommandError && error.kind === 'timeout') {
          throw new ExecCommandError(
            'timeout',
            command,
            `npm run ${script} exceeded run_build's ${RUN_BUILD_TIMEOUT_MS / 1000}s foreground ` +
              `limit. It is still a valid script — re-run it as run_build with background: true, ` +
              `then poll monitor_execution for the execution_id it returns.`,
          );
        }
        throw error;
      }
      const out = result.stdout.slice(0, MAX_OUTPUT_CHARS);
      let formatted = out;
      if (result.stderr) formatted += `\n[stderr]\n${result.stderr.slice(0, MAX_OUTPUT_CHARS)}`;
      formatted += `\n[exit code: ${result.exitCode ?? 'null'}]`;
      return formatted;
    },
  };
}
