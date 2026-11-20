import * as fs from 'fs';
import * as path from 'path';
import type { ForgeConfig } from '../config/types';
import type { ToolDefinition } from '../llm/types';
import { unattendedConversations } from '../sidebar/unattendedConversations';
import {
  BackgroundExecutionManager,
  backgroundExecutionManager,
} from './BackgroundExecutionManager';
import { execCwdPreview, resolveExecCwd, runShellInForeground } from './execHelpers';
import { warmWindowsJobKeeper } from '../util/windowsJobKeeper';
import { NOTIFY_ON_EXIT_DESCRIPTION } from './backgroundExecutionTools';
import { resolveGitBash, systemProbe } from './execProgramResolver';
import { type ShellClassification, type ShellSecretCheck } from './shellPolicy';
import {
  classifyShellCall,
  clankerMayRunShellRefusal,
  clankerShellRefusalApproval,
  matchedRuleGate,
} from './shellToolCallGate';
import type { ShellKind } from './shellCommandTokens';
import { ShellOutputCollector } from './shellOutput';
import { DEFAULT_TOOL_OUTPUT_LIMITS } from './toolOutputLimits';
import type { RegisteredTool } from './ToolRegistry';
import { markConversationReadSecret } from './exfilTaint';
import { shellTimeoutError, TIMEOUT_HINT } from './shellToolTimeout';
import { appendElevationResultNote } from './shellScriptFiles';
import { andChainHint, gitIdentityHint, pwshHint } from './commandHints';

export { posixIdioms } from './commandHints';

export interface ShellToolOptions {
  getConfig?: () => ForgeConfig;
  manager?: BackgroundExecutionManager;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** The home folder `~` and `$env:USERPROFILE` expand against, for the
   *  secret-path gate. Absent means `os.homedir()`; injectable so a test does
   *  not depend on who is logged in on this machine. */
  home?: string;
  /** Test seam; production resolves Git Bash by location. */
  bashPath?: string;
  /**
   * Folder appended to the child's PATH: `registerAllTools` passes VS Code's
   * bundled `rg`, since most machines have none on PATH.
   */
  ripgrepDir?: () => string | undefined;
  /** Live normalized roots that `ownerPaths.ts` forbids changing. */
  ownerOnly?: () => readonly string[];
  clankerMode?: (conversationId: string) => boolean;
}

/** The PATH helpers live in `shellPathEnv.ts`; re-exported so the tests that
 *  name them keep one import path. */
export { gitBashDir, withPathEntry } from './shellPathEnv';
import { gitBashDir, withPathEntry } from './shellPathEnv';

/**
 * True when this turn is a scheduled job run. The agent_task runner marks its
 * conversation with the job's meta for the whole turn, so the shell tool reads
 * that marker instead of threading a "is this a job" argument through every
 * caller: a job turn has already written its RESULT: line, and a wake turn
 * would report the same run again, so a job run keeps the opt-in default.
 */
function isAgentTaskTurn(conversationId: string | undefined): boolean {
  if (!conversationId) return false;
  return unattendedConversations.jobMeta(conversationId) !== undefined;
}

/**
 * Unset `permissions.exec.shell` means bash everywhere Git Bash exists: local
 * models write bash, and on pwsh they lost rounds to `sort -rn` and unexpanded
 * globs. Windows without Git for Windows gets pwsh, and the tool's description
 * names whichever shell is active.
 */
function configuredShell(
  options: ShellToolOptions,
  requested: unknown,
  hasGitBash: () => boolean,
): ShellKind {
  if (requested === 'pwsh' || requested === 'bash') return requested;
  const configured = options.getConfig?.().permissions?.exec?.shell;
  if (configured) return configured === 'powershell' ? 'powershell' : configured;
  if ((options.platform ?? process.platform) !== 'win32') return 'bash';
  return hasGitBash() ? 'bash' : 'pwsh';
}

const SHELL_NAMES: Record<ShellKind, string> = {
  bash: 'bash',
  pwsh: 'PowerShell 7 (pwsh)',
  powershell: 'Windows PowerShell',
};

function findOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const extensions =
    process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const entry of (env.PATH ?? '').split(path.delimiter)) {
    if (!entry) continue;
    for (const extension of extensions) {
      const candidate = path.join(entry, name + (path.extname(name) ? '' : extension));
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function resolveShell(
  shell: ShellKind,
  options: ShellToolOptions,
): { command: string; args: string[] } {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (shell === 'pwsh' || shell === 'powershell') {
    if (shell === 'powershell' && platform !== 'win32') {
      throw new Error(
        'powershell: Windows PowerShell is only available on Windows; choose pwsh or bash.',
      );
    }
    const executable =
      shell === 'pwsh' ? (platform === 'win32' ? 'pwsh.exe' : 'pwsh') : 'powershell.exe';
    const found =
      findOnPath(executable, env) ??
      (shell === 'pwsh' && env.ProgramFiles
        ? path.join(env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe')
        : undefined);
    const prefix = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;';
    return {
      command: found ?? executable,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', prefix],
    };
  }
  if (options.bashPath && platform !== 'win32') {
    return { command: options.bashPath, args: ['-c'] };
  }
  if (platform === 'win32') {
    if (options.bashPath)
      return { command: options.bashPath, args: ['--noprofile', '--norc', '-c'] };
    return { command: resolveGitBash(systemProbe(), env), args: ['--noprofile', '--norc', '-c'] };
  }
  return { command: fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash', args: ['-c'] };
}

function invocation(
  shell: ShellKind,
  command: string,
  options: ShellToolOptions,
): { command: string; args: string[] } {
  const resolved = resolveShell(shell, options);
  if (shell === 'pwsh' || shell === 'powershell') {
    resolved.args[resolved.args.length - 1] =
      `[Console]::OutputEncoding=[Text.Encoding]::UTF8;${command}`;
  } else resolved.args.push(command);
  return resolved;
}

function definition(windows: boolean, shell: ShellKind): ToolDefinition {
  const name = SHELL_NAMES[shell];
  const properties: Record<string, unknown> = {
    command: {
      type: 'string',
      description: `One ${name} command line. Pipes, &&, globs and redirection work.`,
    },
    cwd: {
      type: 'string',
      description:
        'Workspace-relative or absolute working directory. When omitted, every call starts in the workspace root, so a command needs no leading cd there. Set it when the project is in a subfolder. Relative paths inside the command resolve from cwd.',
    },
    timeout_ms: {
      type: 'integer',
      minimum: 1000,
      maximum: 600000,
      description: TIMEOUT_HINT,
    },
    background: {
      type: 'boolean',
      description: 'Start in the background and return an execution_id.',
    },
    notify_on_exit: { type: 'boolean', description: NOTIFY_ON_EXIT_DESCRIPTION },
  };
  if (windows)
    properties['shell'] = {
      type: 'string',
      enum: ['pwsh', 'bash'],
      description: `Windows only: run this call in another shell (default ${shell}).`,
    };
  return {
    type: 'function',
    function: {
      name: 'shell',
      description:
        `Run one command line in ${name}${windows ? ' on Windows' : ''}; rg on PATH is the binary grep_search and find_files use.` +
        ' Search or filter many files in ONE command (rg, globs, pipes), not one call per file. Destructive commands require approval; unsafe commands are refused.' +
        (windows && shell === 'bash'
          ? ' bash\'s /tmp is not where Windows programs such as node look for /tmp: put scratch files in a workspace-relative directory. bash turns a lone /switch into a path (schtasks /query reaches schtasks as C:/Program Files/Git/query): for a Windows program taking /switches set "shell": "pwsh" on the call, or write //query. Run PowerShell by setting "shell": "pwsh", never powershell -Command inside bash: bash expands $variables first, and Git\'s usr/bin shadows System32 there (Start-Process notepad finds Git\'s notepad script, not notepad.exe).'
          : '') +
        (windows
          ? ' Admin (UAC) prompts need the owner at the PC: elevate only for drivers, services, HKLM or Program Files; put every admin step in one script logging to the workspace or C:\\Users\\Public, never C:\\Windows\\Temp.'
          : ''),
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['command'],
        properties,
      },
    },
  };
}

function formatResult(
  code: number | null,
  seconds: number,
  timedOut: boolean,
  text: string,
): string {
  return `exit ${code ?? 'null'} · ${seconds.toFixed(1)} s${timedOut ? ' · timed out' : ''}\n${text}`;
}

export function makeShellTool(options: ShellToolOptions = {}): RegisteredTool {
  const platform = options.platform ?? process.platform;
  const manager = options.manager ?? backgroundExecutionManager;
  // undefined = not probed yet; null = probed, no Git for Windows.
  let bashDir: string | null | undefined;
  const gitBash = (): string | undefined =>
    (bashDir === undefined ? (bashDir = gitBashDir(options) ?? null) : bashDir) ?? undefined;
  const shellFor = (requested: unknown): ShellKind =>
    configuredShell(options, requested, () => gitBash() !== undefined);
  /**
   * The gates' view of one call: the tool's config, home and platform, plus the
   * two things only this call knows — the folder its relative paths resolve
   * against, and the owner-only roots. Both are read here rather than in
   * `classifyShellCommand` because `approval`, `autoApproveIf` and the handler
   * are three calls of the same classifier and must give the same answer for the
   * same `args`: a refusal the handler alone saw would be a card first.
   */
  const checkFor = (args: Record<string, unknown>): ShellSecretCheck => {
    const roots = options.ownerOnly?.();
    const base = execCwdPreview(typeof args['cwd'] === 'string' ? args['cwd'] : undefined);
    return {
      ...(options.getConfig ? { getConfig: options.getConfig } : {}),
      ...(options.home ? { home: options.home } : {}),
      ...(options.platform ? { platform: options.platform } : {}),
      ...(roots && roots.length > 0 ? { ownerOnly: roots } : {}),
      ...(base ? { cwd: base } : {}),
    };
  };
  /**
   * The approval key for one classified call. The key the GATE knows (`rdelete:`,
   * `secret:`) wins over the key the EXIT knows (`net:prog:`), because the gate is
   * what raised this card: a command that both reads a secret file and runs `curl`
   * must not be answerable by a rule for `curl`, or the secret read goes unasked.
   */
  const approvalKeyFor = (classified: ShellClassification): string | undefined =>
    classified.approvalKey ??
    (classified.networkProgram ? `net:prog:${classified.networkProgram}` : undefined);
  const tool: RegisteredTool = {
    // A literal on purpose: scripts/tool-audit-catalog.mjs reads it from source.
    // describe() is what is advertised, with the Windows-only `shell` override.
    definition: {
      type: 'function',
      function: {
        name: 'shell',
        description:
          'Run one command line in bash (PowerShell on Windows without Git for Windows); rg on PATH is the binary grep_search and find_files use. Search or filter many files in ONE command (rg, globs, pipes), not one call per file. Destructive commands require approval; unsafe commands are refused.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['command'],
          properties: {
            command: {
              type: 'string',
              description:
                'One command line for the active shell. Pipes, &&, globs and redirection work.',
            },
            cwd: {
              type: 'string',
              description:
                'Workspace-relative or absolute working directory. When omitted, every call starts in the workspace root, so a command needs no leading cd there. Set it when the project is in a subfolder. Relative paths inside the command resolve from cwd.',
            },
            timeout_ms: {
              type: 'integer',
              minimum: 1000,
              maximum: 600000,
              description: TIMEOUT_HINT,
            },
            background: {
              type: 'boolean',
              description: 'Start in the background and return an execution_id.',
            },
            notify_on_exit: { type: 'boolean', description: NOTIFY_ON_EXIT_DESCRIPTION },
          },
        },
      },
    },
    describe: () => definition(platform === 'win32', shellFor(undefined)),
    permission: 'headless',
    approval: (args, approvalContext) => {
      const shell = shellFor(args['shell']);
      const result = classifyShellCall(args, shell, checkFor(args));
      const approvalKey = approvalKeyFor(result);
      if (result.classification === 'refused') {
        const conversationId = approvalContext?.conversationId;
        return clankerShellRefusalApproval(
          result,
          String(args['command']),
          conversationId !== undefined && options.clankerMode?.(conversationId) === true,
          conversationId !== undefined && !unattendedConversations.has(conversationId),
        );
      }
      if (result.classification === 'normal')
        return {
          detail: `${String(args['command'])}\ncwd: ${String(args['cwd'] ?? '(workspace root)')}\nshell: ${shell}`,
          // The classifier matched no rule, so this is the card's text, not a gate:
          // `untrustedExitPolicy.ts` decides whether a card opens, and a clean chat
          // runs the command with none.
          cardTextOnly: true,
          ...(result.networkReaching ? { reachesOut: 'network' } : {}),
          ...(approvalKey ? { approvalKey } : {}),
        };
      if (result.classification === 'read_only')
        // A read-only command can still reach a host (`curl -I https://x`), and the
        // classifier lets it through. In a flagged chat the egress rule still wants
        // the owner, so the way out is reported even though this metadata asks for no
        // card of its own — and the program is named with it, so that card is the one
        // a chat rule can answer.
        return result.networkReaching
          ? {
              cardTextOnly: true,
              reachesOut: 'network',
              ...(approvalKey ? { approvalKey } : {}),
            }
          : undefined;
      if (result.classification === 'dangerous')
        return {
          detail: `${String(args['command'])}\nMatched rule: ${result.rule?.description ?? 'destructive command'}${
            result.rule?.alternative ? `\nSafer way: ${result.rule.alternative}` : ''
          }`,
          dangerous: true,
          ...(result.networkReaching ? { reachesOut: 'network' } : {}),
          ...(approvalKey ? { approvalKey } : {}),
          ...(result.approvalTargets ? { approvalTargets: result.approvalTargets } : {}),
          ...(result.rule?.alternative ? { declineHint: result.rule.alternative } : {}),
          ...matchedRuleGate(result.rule),
          ...(result.rule ? { cardReason: `Matched rule: ${result.rule.description}` } : {}),
        };
      return undefined;
    },
    autoApproveIf: (args) =>
      ['read_only', 'refused'].includes(
        classifyShellCall(args, shellFor(args['shell']), checkFor(args)).classification,
      ),
    handler: async (args, context) => {
      if (typeof args['command'] !== 'string' || args['command'].length === 0)
        throw new Error('shell: command must be a non-empty string.');
      if (args['cwd'] !== undefined && typeof args['cwd'] !== 'string')
        throw new Error('shell: cwd must be a string.');
      const timeoutError = shellTimeoutError(args['timeout_ms']);
      if (timeoutError) throw new Error(timeoutError);
      if (
        args['shell'] !== undefined &&
        (platform !== 'win32' || !['pwsh', 'bash'].includes(String(args['shell'])))
      ) {
        throw new Error('shell: shell can be pwsh or bash on Windows only.');
      }
      const command = args['command'];
      const shell = shellFor(args['shell']);
      const classified = classifyShellCall(args, shell, checkFor(args));
      if (
        classified.classification === 'refused' &&
        !clankerMayRunShellRefusal(
          classified,
          context?.clankerMode === true,
          context?.conversationId !== undefined &&
            !unattendedConversations.has(context.conversationId),
        )
      ) {
        throw new Error(
          `shell: ${classified.rule?.description ?? 'command refused'} (deny list) — ${classified.rule?.alternative ?? 'choose a safe alternative'}`,
        );
      }
      const background = args['background'] === true;
      const notifyOnExit = args['notify_on_exit'];
      if (notifyOnExit === true && !background)
        throw new Error('shell: notify_on_exit requires background=true.');
      if (notifyOnExit === true && !context?.conversationId)
        throw new Error('shell: notify_on_exit requires a conversation.');
      // On by default for a background command in a chat: a flag that has to be
      // remembered at launch and cannot be added later made an agent that
      // forgot it spend four rounds polling. `false` is the opt-out (a server
      // the agent does not want to hear about); a scheduled job run keeps the
      // opt-in default (see isAgentTaskTurn); an explicit flag wins either way,
      // and an omitted flag with no conversation arms nothing and errors nothing.
      const wakeOnExit =
        notifyOnExit !== false &&
        (notifyOnExit === true || !isAgentTaskTurn(context?.conversationId));
      const cwd = resolveExecCwd(typeof args['cwd'] === 'string' ? args['cwd'] : undefined);
      const timeout = typeof args['timeout_ms'] === 'number' ? args['timeout_ms'] : 120_000;
      const resolved = invocation(shell, command, options);
      const environment = {
        ...withPathEntry(
          withPathEntry(options.env ?? process.env, options.ripgrepDir?.()),
          platform === 'win32' ? gitBash() : undefined,
          'prepend',
        ),
        ...(context?.conversationId ? { FORGE_CONVERSATION_ID: context.conversationId } : {}),
        GIT_TERMINAL_PROMPT: '0',
      };
      if (background) {
        // The job helper must hold the job before the command's first fork.
        await warmWindowsJobKeeper();
        const start = manager.start({
          command: resolved.command,
          args: resolved.args,
          cwd,
          ...(typeof args['timeout_ms'] === 'number' ? { timeoutMs: timeout } : {}),
          env: environment,
          ...(wakeOnExit && context?.conversationId
            ? { notifyConversationId: context.conversationId }
            : {}),
        });
        return appendElevationResultNote(
          `execution_id: ${start.id}\nstatus: ${start.status}\npid: ${start.pid ?? 'unknown'}`,
          classified.elevatedProcess,
        );
      }
      const output = new ShellOutputCollector(
        context?.conversationId ?? 'unknown',
        context?.toolCallId ?? 'unknown',
        context?.outputLimits?.shellInlineChars ?? DEFAULT_TOOL_OUTPUT_LIMITS.shellInlineChars,
      );
      try {
        const result = await runShellInForeground(
          resolved.command,
          resolved.args,
          cwd,
          timeout,
          environment,
          context?.abortSignal,
          output,
        );
        const capped = await output.finish();
        // The command printed a secret path into this chat, allow list or not,
        // so its next fetch is judged; a background run is not marked, as its
        // output never reaches the chat.
        if (classified.readSecretIgnoringAllowList)
          markConversationReadSecret(
            context?.conversationId,
            classified.readSecretIgnoringAllowList,
            `shell "${command}"`,
          );
        return appendElevationResultNote(
          formatResult(result.code, result.seconds, result.timedOut, capped.text) +
            pwshHint(shell, result.code, command) +
            andChainHint(shell, result.code, result.timedOut, command) +
            gitIdentityHint(capped.text),
          classified.elevatedProcess,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && shell === 'pwsh') {
          throw new Error(
            'pwsh: PowerShell 7 is missing. Install PowerShell 7 using the MSI, or set permissions.exec.shell: powershell.',
          );
        }
        throw error;
      }
    },
  };
  return tool;
}
