import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { terminateCliProcessTree } from '../agents/cliProcess';
import type { ForgeConfig } from '../config/types';
import type { ToolDefinition } from '../llm/types';
import { normalizeSpawnCwd } from '../util/processSpawn';
import {
  BackgroundExecutionManager,
  backgroundExecutionManager,
} from './BackgroundExecutionManager';
import { resolveExecCwd } from './execHelpers';
import { resolveGitBash } from './execProgramResolver';
import { classifyShellCommand, type ShellClassification, type ShellKind } from './shellPolicy';
import { capShellOutput } from './shellOutput';
import type { RegisteredTool } from './ToolRegistry';

export interface ShellToolOptions {
  getConfig?: () => ForgeConfig;
  manager?: BackgroundExecutionManager;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Test seam; production resolves Git Bash by location. */
  bashPath?: string;
  /**
   * Folder appended to the child's PATH: `registerAllTools` passes VS Code's
   * bundled `rg`, since most machines have none on PATH.
   */
  ripgrepDir?: () => string | undefined;
}

/**
 * Adds `dir` to PATH (key case varies on Windows). Appending lets a
 * user-installed program win; prepending makes `dir` win.
 */
export function withPathEntry(
  env: NodeJS.ProcessEnv,
  dir: string | undefined,
  position: 'append' | 'prepend' = 'append',
): NodeJS.ProcessEnv {
  if (!dir) return env;
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  const entries = (env[key] ?? '').split(path.delimiter).filter(Boolean);
  if (position === 'append') {
    if (entries.includes(dir)) return env;
    return { ...env, [key]: [...entries, dir].join(path.delimiter) };
  }
  if (entries[0] === dir) return env;
  return { ...env, [key]: [dir, ...entries.filter((entry) => entry !== dir)].join(path.delimiter) };
}

function windowsProbe(): { which: (name: string) => string[]; exists: (p: string) => boolean } {
  return {
    which: (name: string) => {
      const result = spawnSync('where.exe', [name], { encoding: 'utf8' });
      return (result.stdout ?? '')
        .split(/\r?\n/u)
        .map((value) => value.trim())
        .filter(Boolean);
    },
    exists: (candidate: string) => fs.existsSync(candidate),
  };
}

/**
 * Git Bash's folder, put FIRST on a Windows child's PATH: `bash x.sh` inside a
 * pwsh command line would otherwise resolve System32's WSL launcher, the
 * WSL#41592 crash path.
 */
export function gitBashDir(
  options: Pick<ShellToolOptions, 'bashPath' | 'env'>,
): string | undefined {
  if (options.bashPath) return path.win32.dirname(options.bashPath);
  try {
    return path.win32.dirname(resolveGitBash(windowsProbe(), options.env ?? process.env));
  } catch {
    // No Git for Windows: nothing to put first; `shell: bash` itself still refuses.
    return undefined;
  }
}

const NOTIFY_ON_EXIT_DESCRIPTION =
  'When true, send the user a message when this background command exits. Requires background=true.';
const classifications = new WeakMap<Record<string, unknown>, ShellClassification>();

function getClassification(args: Record<string, unknown>, shell: ShellKind): ShellClassification {
  const existing = classifications.get(args);
  if (existing) return existing;
  const value = classifyShellCommand(String(args['command'] ?? ''), shell);
  classifications.set(args, value);
  return value;
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
    return { command: resolveGitBash(windowsProbe(), env), args: ['--noprofile', '--norc', '-c'] };
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
        'Workspace-relative or absolute working directory. Omitted, every call starts in the workspace root, so a command needs no leading cd there. Set it when the project is in a subfolder.',
    },
    timeout_ms: {
      type: 'integer',
      minimum: 1000,
      maximum: 600000,
      description: 'Foreground timeout in milliseconds (default 120000).',
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
        `Run one command line in ${name}${windows ? ' on Windows' : ''}; rg on PATH is the binary search_code and find_files use.` +
        ' Search or filter many files in ONE command (rg, globs, pipes), not one call per file. Destructive commands require approval; unsafe commands are refused.' +
        (windows && shell === 'bash'
          ? " bash's /tmp is not where node or other Windows programs look for /tmp: put scratch files in a workspace-relative directory."
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

const POSIX_ONLY = new Set([
  'head',
  'tail',
  'wc',
  'sed',
  'awk',
  'uniq',
  'xargs',
  'cut',
  'tr',
  'grep',
]);
const GLOB_TAKERS = new Set(['rg', 'grep', 'cat', 'wc', 'head', 'tail']);

/**
 * Names the POSIX idioms in a command that failed under PowerShell, where
 * native tools get globs unexpanded and `sort -rn` hits Sort-Object. Whole
 * tokens only; quoted arguments are not inspected.
 */
export function posixIdioms(command: string): string[] {
  const found = new Set<string>();
  for (const segment of command.split(/\||&&|;/u)) {
    const tokens = segment.trim().split(/\s+/u).filter(Boolean);
    const [head, flag] = tokens;
    if (!head) continue;
    if (POSIX_ONLY.has(head)) found.add(head);
    if (head === 'sort' && flag?.startsWith('-')) found.add(`sort ${flag}`);
    if (head === 'for' && tokens[2] === 'in') found.add('a for … in loop');
    if (GLOB_TAKERS.has(head) && tokens.slice(1).some((t) => t.includes('*') && !/^['"-]/u.test(t)))
      found.add(`${head} with a bare glob`);
  }
  return [...found];
}

function pwshHint(shell: ShellKind, code: number | null, command: string): string {
  if ((shell !== 'pwsh' && shell !== 'powershell') || code === 0) return '';
  const idioms = posixIdioms(command);
  if (!idioms.length) return '';
  return `\nThis ran in PowerShell, but the command uses POSIX syntax (${idioms.join(', ')}). Rerun it with shell: "bash".`;
}

async function runForeground(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
): Promise<{ code: number | null; timedOut: boolean; output: string; seconds: number }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const proc = spawn(executable, args, {
      shell: false,
      cwd: normalizeSpawnCwd(cwd),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...env,
        FORGE_CONVERSATION_ID: env.FORGE_CONVERSATION_ID,
        GIT_TERMINAL_PROMPT: '0',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
      ...(process.platform !== 'win32' ? { detached: true } : {}),
    });
    let output = '';
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve({ code, timedOut, output, seconds: (Date.now() - started) / 1000 });
    };
    const abort = (): void => {
      void terminateCliProcessTree(proc);
      finish(null);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateCliProcessTree(proc);
      finish(null);
    }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      output += chunk;
    });
    proc.stderr.on('data', (chunk: string) => {
      output += chunk;
    });
    proc.once('error', reject);
    proc.once('close', (code) => finish(code));
  });
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
  const tool: RegisteredTool = {
    // A literal on purpose: scripts/tool-audit-catalog.mjs reads it from source.
    // describe() is what is advertised, with the Windows-only `shell` override.
    definition: {
      type: 'function',
      function: {
        name: 'shell',
        description:
          'Run one command line in bash (PowerShell on Windows without Git for Windows); rg on PATH is the binary search_code and find_files use. Search or filter many files in ONE command (rg, globs, pipes), not one call per file. Destructive commands require approval; unsafe commands are refused.',
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
                'Workspace-relative or absolute working directory. Omitted, every call starts in the workspace root, so a command needs no leading cd there. Set it when the project is in a subfolder.',
            },
            timeout_ms: {
              type: 'integer',
              minimum: 1000,
              maximum: 600000,
              description: 'Foreground timeout in milliseconds (default 120000).',
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
    approval: (args) => {
      const shell = shellFor(args['shell']);
      const result = getClassification(args, shell);
      if (result.classification === 'normal')
        return {
          detail: `${String(args['command'])}\ncwd: ${String(args['cwd'] ?? '(workspace root)')}\nshell: ${shell}`,
        };
      if (result.classification === 'dangerous')
        return {
          detail: `${String(args['command'])}\nMatched rule: ${result.rule?.description ?? 'destructive command'}`,
          dangerous: true,
        };
      return undefined;
    },
    autoApproveIf: (args) =>
      ['read_only', 'refused'].includes(
        getClassification(args, shellFor(args['shell'])).classification,
      ),
    handler: async (args, context) => {
      if (typeof args['command'] !== 'string' || args['command'].length === 0)
        throw new Error('shell: command must be a non-empty string.');
      if (args['cwd'] !== undefined && typeof args['cwd'] !== 'string')
        throw new Error('shell: cwd must be a string.');
      if (
        args['timeout_ms'] !== undefined &&
        (!Number.isInteger(args['timeout_ms']) ||
          Number(args['timeout_ms']) < 1000 ||
          Number(args['timeout_ms']) > 600000)
      ) {
        throw new Error('shell: timeout_ms must be an integer from 1000 to 600000.');
      }
      if (
        args['shell'] !== undefined &&
        (platform !== 'win32' || !['pwsh', 'bash'].includes(String(args['shell'])))
      ) {
        throw new Error('shell: shell can be pwsh or bash on Windows only.');
      }
      const command = args['command'];
      const shell = shellFor(args['shell']);
      const classified = getClassification(args, shell);
      if (classified.classification === 'refused') {
        throw new Error(
          `shell: ${classified.rule?.description ?? 'command refused'} — ${classified.rule?.alternative ?? 'choose a safe alternative'}`,
        );
      }
      const background = args['background'] === true;
      if (args['notify_on_exit'] === true && !background)
        throw new Error('shell: notify_on_exit requires background=true.');
      if (args['notify_on_exit'] === true && !context?.conversationId)
        throw new Error('shell: notify_on_exit requires a conversation.');
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
        const start = manager.start({
          command: resolved.command,
          args: resolved.args,
          cwd,
          ...(typeof args['timeout_ms'] === 'number' ? { timeoutMs: timeout } : {}),
          env: environment,
          ...(args['notify_on_exit'] === true && context?.conversationId
            ? { notifyConversationId: context.conversationId }
            : {}),
        });
        return `execution_id: ${start.id}\nstatus: ${start.status}\npid: ${start.pid ?? 'unknown'}`;
      }
      try {
        const result = await runForeground(
          resolved.command,
          resolved.args,
          cwd,
          timeout,
          environment,
          context?.abortSignal,
        );
        const capped = await capShellOutput(
          result.output,
          context?.conversationId ?? 'unknown',
          context?.toolCallId ?? 'unknown',
        );
        return (
          formatResult(result.code, result.seconds, result.timedOut, capped.text) +
          pwshHint(shell, result.code, command)
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
