import { spawn } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { terminateCliProcessTree } from '../agents/cliProcess';
import { protectProcessTree, warmWindowsJobKeeper } from '../util/windowsJobKeeper';
import { ShellOutputCollector } from './shellOutput';

export const MAX_OUTPUT_CHARS = 16_000;
export const MAX_OUTPUT_CHARS_CEILING = 32_000;
const MAX_EXEC_OUTPUT_LINES = 2_000;

type ExecOutputStream = 'both' | 'stdout' | 'stderr';

export interface ExecOutputOptions {
  /** Return the first N lines from each selected stream. */
  headLines?: number;
  /** Return the final N lines from each selected stream. */
  tailLines?: number;
  /** Maximum returned characters per selected stream. */
  maxChars?: number;
  /** Limit returned data to stdout, stderr, or both streams. */
  stream?: ExecOutputStream;
  /** Whether maxChars came from the request rather than the model default. */
  maxCharsExplicit?: boolean;
  /** Whether a request exceeded the model-scaled output bound. */
  maxCharsClamped?: boolean;
}

/**
 * Validates the bounded output-shaping controls accepted by `background execution`.
 * They intentionally affect only what returns to the model, never what is
 * executed, so they cover common pipe use cases without granting a shell.
 */
export function parseExecOutputOptions(
  args: Record<string, unknown>,
  outputLimit = MAX_OUTPUT_CHARS,
): ExecOutputOptions {
  const readBoundedInt = (key: string, max: number): number | undefined => {
    const value = args[key];
    if (value === undefined) return undefined;
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) {
      const fileAlternative =
        key === 'max_output_chars'
          ? ' Redirect command output to a file and read it with read_file for a larger text result.'
          : '';
      throw new Error(
        `background execution: ${key} must be an integer from 1 to ${max}.${fileAlternative}`,
      );
    }
    return value as number;
  };

  const headLines = readBoundedInt('head_lines', MAX_EXEC_OUTPUT_LINES);
  const tailLines = readBoundedInt('tail_lines', MAX_EXEC_OUTPUT_LINES);
  if (headLines !== undefined && tailLines !== undefined) {
    throw new Error('background execution: head_lines and tail_lines cannot be used together.');
  }
  const maxChars = readBoundedInt('max_output_chars', MAX_OUTPUT_CHARS_CEILING);
  const explicitMax = maxChars !== undefined;
  const rawStream = args['output_stream'];
  if (
    rawStream !== undefined &&
    rawStream !== 'both' &&
    rawStream !== 'stdout' &&
    rawStream !== 'stderr'
  ) {
    throw new Error('background execution: output_stream must be "both", "stdout", or "stderr".');
  }
  return {
    ...(headLines !== undefined ? { headLines } : {}),
    ...(tailLines !== undefined ? { tailLines } : {}),
    maxChars: Math.min(maxChars ?? outputLimit, outputLimit),
    maxCharsExplicit: explicitMax,
    ...(maxChars !== undefined && maxChars > outputLimit ? { maxCharsClamped: true } : {}),
    ...(rawStream !== undefined ? { stream: rawStream } : {}),
  };
}

// ── Workspace helpers ──────────────────────────────────────────────────────────

/**
 * The folder a command's relative paths resolve against, decided lexically and
 * without touching the file system: the workspace root, or `cwd` joined to it.
 *
 * `resolveExecCwd` below is this answer plus the existence checks. The split
 * exists because the owner-only guard runs in `autoApproveIf` and `approval`,
 * which `ToolDispatch.ts` calls before the handler has validated `cwd`: a guard
 * that called the checked version would throw "cwd does not exist" from a hook,
 * reporting the wrong thing for the wrong reason.
 */
export function execCwdPreview(cwd: string | undefined): string | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return undefined;
  const requested = cwd?.trim();
  return normalizeSpawnCwd(
    !requested ? root : path.isAbsolute(requested) ? requested : path.join(root, requested),
  );
}

export function resolveExecCwd(cwd: string | undefined): string {
  // normalizeSpawnCwd here as well as at the spawn, so the cwd reported back to
  // the model is the same spelling the process actually ran under.
  const resolved = execCwdPreview(cwd);
  if (resolved === undefined) throw new Error('No workspace folder open');
  const problem = cwdProblem(resolved);
  if (problem === 'missing') {
    throw new Error(
      `shell: cwd ${JSON.stringify(cwd ?? resolved)} does not exist (resolved to ${resolved}). ` +
        'Create it first - write_file to a file inside it, or mkdir in the command - ' +
        'or leave cwd out.',
    );
  }
  if (problem === 'not_folder') {
    throw new Error(
      `shell: cwd ${JSON.stringify(cwd ?? resolved)} is not a folder (resolved to ${resolved}).`,
    );
  }
  return resolved;
}

// ── Core spawn helper ──────────────────────────────────────────────────────────

/**
 * Process spawning lives in `util/processSpawn.ts` (no `vscode` import) so
 * vscode-free callers can use it. Re-exported here to keep existing importers
 * — and this module's own use below — on one name.
 */
export {
  ExecCommandError,
  normalizeSpawnCwd,
  spawnAndWait,
  type ExecCommandErrorKind,
  type SpawnResult,
} from '../util/processSpawn';
import { cwdProblem, normalizeSpawnCwd } from '../util/processSpawn';

// ── ANSI stripping ───────────────────────────────────────────────────────────

// CSI escape matcher: ESC [ <params> <final-letter>. Covers SGR color (…m) and
// cursor/erase codes (…K, …G) that tools like vitest emit on stdout/stderr; left
// unstripped they pollute both the board display and the model's context.
// Written as a regex literal so the ESC byte is an escape, never a raw control char.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, '');
}

// ── Foreground run ────────────────────────────────────────────────────────────

/**
 * Runs one command line in the foreground and resolves only once its process
 * tree is dead — the next command must not race the files this one is writing.
 *
 * It lives here with the other exec child-process helpers, moved out of
 * `shellTool.ts` when that file reached the 500-line gate. The two rules it
 * carries are the ones a rewrite loses first:
 * - Kill the TREE, not just the child. Windows used to kill bash first, so
 *   `taskkill /T` found no parent, the native grandchild kept running, and it
 *   held the cwd and the files the next command wanted.
 * - `detached` only off Windows: without it an abort on POSIX kills the shell
 *   and leaves `sleep 600` behind.
 * `FORGE_CONVERSATION_ID` is passed through deliberately — a backgrounded
 * command uses it to report which chat may be notified when it exits.
 */
export async function runShellInForeground(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  output: ShellOutputCollector,
): Promise<{ code: number | null; timedOut: boolean; seconds: number }> {
  const started = Date.now();
  // The job helper has to hold the job before this command's first fork, so it
  // is started before the spawn, not after it (`warmWindowsJobKeeper`). The
  // command already pays about 270 ms once per window for that.
  await warmWindowsJobKeeper();
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
    // The job object is the half of the tree kill that survives an MSYS2 forker:
    // `terminateCliProcessTree` below walks parent links, and a grandchild whose
    // creator already exited has none (lab BUG-27). This path has its own spawn
    // rather than `spawnAndWait`, so it needs the protection itself.
    protectProcessTree(proc);
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      resolve({ code, timedOut, seconds: (Date.now() - started) / 1000 });
    };
    // Resolve only once the tree is dead, or the next command races its files.
    let killing = false;
    const stop = (): void => {
      if (killing || settled) return;
      killing = true;
      clearTimeout(timer);
      void terminateCliProcessTree(proc).then(() => finish(null));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    output.collect(proc.stdout);
    output.collect(proc.stderr);
    proc.once('error', reject);
    proc.once('close', (code) => !killing && finish(code));
  });
}
