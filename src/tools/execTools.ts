import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';
import {
  checkShellOperators,
  checkPowerShellBan,
  ExecCommandError,
  formatExecCommandOutput,
  inlineScriptStart,
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
} from './execProgramResolver';
import { validateExecEnv } from './execEnvPolicy';
import { checkDenyList, getBuiltinDenyList } from './DenyList';
import { checkExecScriptFile, checkInlineExecScript } from './execScriptScanner';
import { backgroundExecutionManager } from './BackgroundExecutionManager';
import {
  formatBackgroundObservation,
  NOTIFY_ON_EXIT_DESCRIPTION,
} from './backgroundExecutionTools';
import { terminalCommandTracker } from './TerminalCommandTracker';
import {
  describeForgeToolProgram,
  describeMissingExecutable,
  describeWindowsShimSpawnFailure,
  inlineScriptWriteHint,
} from './execHints';

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

export function makeExecCommandTool(
  shellScriptsEnabled: () => boolean = () => false,
  registeredToolNames: () => readonly string[] = () => [],
): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'exec_command',
        description:
          'Run an executable directly without a shell; pass args separately. Bare rg uses VS Code bundled ripgrep; search_code is the scoped default for repository searches. npm/npx work cross-platform — `npm test` / `npm run <script>` work directly (no shell needed). Shell builtins, operators, and dangerous commands are refused. Shell scripts require permissions.exec.shell_scripts in config.yaml. Use the output options instead of pipes. Long jobs: background=true + monitor_execution or notify_on_exit.',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description:
                'Executable name or path. Bare rg/rg.exe use VS Code bundled ripgrep; bare npm/npx are resolved on Windows; bare bash is Git Bash, not WSL.',
            },
            args: { type: 'array', items: { type: 'string' }, description: 'Arguments array.' },
            cwd: { type: 'string', description: 'Working directory. Optional.' },
            env: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description:
                'Optional env vars for the process; dangerous names (PATH, NODE_OPTIONS, …) are refused.',
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
                'Return at most this many characters per stream (default cap ' +
                `${String(MAX_EXEC_STORED_CHARS)}). Output past the bound is lost.`,
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
            notify_on_exit: {
              type: 'boolean',
              description: NOTIFY_ON_EXIT_DESCRIPTION,
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
      const requestedTimeoutMs = args['timeout_ms'] as number | undefined;
      const timeoutMs = requestedTimeoutMs ?? 30_000;
      const notifyOnExit = args['notify_on_exit'] === true;
      if (notifyOnExit && args['background'] !== true) {
        throw new Error('notify_on_exit requires background: true.');
      }
      if (notifyOnExit && !context?.conversationId) {
        throw new Error('notify_on_exit requires a conversation; start this job from a chat.');
      }
      const cwd = resolveExecCwd(args['cwd'] as string | undefined);
      const shellScripts = shellScriptsEnabled();
      const forgeToolHint = describeForgeToolProgram(command, registeredToolNames());
      if (forgeToolHint) {
        throw new ExecCommandError('policy_refusal', command, forgeToolHint);
      }
      try {
        checkShellOperators(cmdArgs, shellScripts ? inlineScriptStart(command, cmdArgs) : -1);
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
      const childEnv = {
        ...envCheck.env,
        ...(context?.conversationId ? { FORGE_CONVERSATION_ID: context.conversationId } : {}),
      };
      try {
        const denied = checkDenyList(command, cmdArgs, getBuiltinDenyList());
        if (denied) {
          throw new Error(
            `exec_command: command matches denylist pattern "${denied.description}" — execution refused.` +
              (denied.alternative ? ` ${denied.alternative}` : ''),
          );
        }
        checkPowerShellBan(command, cmdArgs, shellScripts);
        checkInlineExecScript(command, cmdArgs, shellScripts);
        checkExecScriptFile(command, cmdArgs, cwd);
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
        spawned = resolveExecInvocation(
          command,
          cmdArgs,
          process.platform,
          undefined,
          vscode.env.appRoot,
        );
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
            env: childEnv,
            ...(notifyOnExit ? { notifyConversationId: context!.conversationId! } : {}),
          });
          // spawn reports a failed launch on the next tick, so observing
          // immediately would report "running" for a process already dead.
          await new Promise((resolve) => setImmediate(resolve));
          const observation = await backgroundExecutionManager.observe(started.id, 0, 0, 0);
          const formatted = formatBackgroundObservation(observation, 0, outputOptions);
          return addExecCommandNote(formatted, inlineScriptWriteHint(command, cmdArgs));
        }
        const result = await spawnAndWait(
          spawned.command,
          spawned.args,
          cwd,
          timeoutMs,
          childEnv,
          context?.abortSignal,
        );
        return addExecCommandNote(
          formatExecCommandOutput(command, result, outputOptions),
          inlineScriptWriteHint(command, cmdArgs),
        );
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
            describeMissingExecutable(command, alternative) ?? error.message,
          );
        }
        const shimHint = describeWindowsShimSpawnFailure(command, error);
        if (shimHint) {
          throw new ExecCommandError('spawn_error', command, shimHint);
        }
        throw error;
      }
    },
  };
}

function addExecCommandNote(result: string, note: string | undefined): string {
  if (!note) return result;
  const parsed = JSON.parse(result) as Record<string, unknown>;
  parsed['note'] = note;
  return JSON.stringify(parsed);
}
