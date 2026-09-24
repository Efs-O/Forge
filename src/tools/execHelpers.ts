import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { checkDenyList, getBuiltinDenyList } from './DenyList';

export const MAX_OUTPUT_CHARS = 16_000;
export const MAX_EXEC_OUTPUT_LINES = 2_000;

/**
 * Upper bound on how much of a command's output is RETURNED, and therefore
 * stored in the transcript and paged by `read_tool_result`.
 *
 * There is no separate "shown" copy: what this function returns is what the
 * round carries. The excerptor in `toolResultContext` shrinks it further only
 * when the window is actually tight, so this bound is the real worst case a
 * single `exec_command` can add — both streams at once, which at ~4 chars per
 * token is roughly 30k tokens. It was 120_000 per stream, i.e. twice that,
 * which is more than a 128k window should ever spend on one command.
 *
 * A caller that wants less says so with `max_output_chars`; that argument is
 * honoured here and never silently ignored.
 */
export const MAX_EXEC_STORED_CHARS = 60_000;

export type ExecOutputStream = 'both' | 'stdout' | 'stderr';

export interface ExecOutputOptions {
  /** Return the first N lines from each selected stream. */
  headLines?: number;
  /** Return the final N lines from each selected stream. */
  tailLines?: number;
  /** Maximum returned characters per selected stream. */
  maxChars?: number;
  /** Limit returned data to stdout, stderr, or both streams. */
  stream?: ExecOutputStream;
}

/**
 * Validates the bounded output-shaping controls accepted by `exec_command`.
 * They intentionally affect only what returns to the model, never what is
 * executed, so they cover common pipe use cases without granting a shell.
 */
export function parseExecOutputOptions(args: Record<string, unknown>): ExecOutputOptions {
  const readBoundedInt = (key: string, max: number): number | undefined => {
    const value = args[key];
    if (value === undefined) return undefined;
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) {
      throw new Error(`exec_command: ${key} must be an integer from 1 to ${max}.`);
    }
    return value as number;
  };

  const headLines = readBoundedInt('head_lines', MAX_EXEC_OUTPUT_LINES);
  const tailLines = readBoundedInt('tail_lines', MAX_EXEC_OUTPUT_LINES);
  if (headLines !== undefined && tailLines !== undefined) {
    throw new Error('exec_command: head_lines and tail_lines cannot be used together.');
  }
  const maxChars = readBoundedInt('max_output_chars', MAX_OUTPUT_CHARS);
  const rawStream = args['output_stream'];
  if (
    rawStream !== undefined &&
    rawStream !== 'both' &&
    rawStream !== 'stdout' &&
    rawStream !== 'stderr'
  ) {
    throw new Error('exec_command: output_stream must be "both", "stdout", or "stderr".');
  }
  return {
    ...(headLines !== undefined ? { headLines } : {}),
    ...(tailLines !== undefined ? { tailLines } : {}),
    ...(maxChars !== undefined ? { maxChars } : {}),
    ...(rawStream !== undefined ? { stream: rawStream } : {}),
  };
}

// ── Workspace helpers ──────────────────────────────────────────────────────────

export function getWorkspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) throw new Error('No workspace folder open');
  return folders[0].uri.fsPath;
}

export function resolveExecCwd(cwd: string | undefined): string {
  // normalizeSpawnCwd here as well as at the spawn, so the cwd reported back to
  // the model is the same spelling the process actually ran under.
  if (!cwd) return normalizeSpawnCwd(getWorkspaceRoot());
  if (path.isAbsolute(cwd)) return normalizeSpawnCwd(cwd);
  return normalizeSpawnCwd(path.join(getWorkspaceRoot(), cwd));
}

// ── Shell-operator guard ───────────────────────────────────────────────────────

/**
 * Tokens that are shell operators when they stand alone as one argument.
 *
 * Matched WHOLE, never as substrings. Commands are spawned with `shell: false`,
 * so an operator character *inside* an argument is passed verbatim to the
 * program and no shell ever sees it — there is nothing to escape and no
 * injection to prevent. Substring matching therefore protected nothing and
 * blocked a great deal: `for(let i=0;i<50;i++)console.log(i)` was refused for
 * containing `;` and `<`, which rules out most `node -e` one-liners, every
 * arrow function, and every comparison. Backticks were the worst of it — a JS
 * template literal could not be passed at all.
 *
 * What is worth catching is the model writing a shell *line* and handing the
 * pieces over as argv, e.g. args: ["-e", "...", "&&", "node", ...]. That shows
 * up as a bare operator token, and it is what this now looks for.
 */
const SHELL_OPERATOR_TOKENS = new Set([
  '&&',
  '||',
  '|',
  '&',
  ';',
  '>',
  '>>',
  '<',
  '<<',
  '2>',
  '2>&1',
]);

export function checkShellOperators(args: string[]): void {
  for (const arg of args) {
    if (SHELL_OPERATOR_TOKENS.has(arg.trim())) {
      throw new Error(
        `Shell operators are not permitted in arguments ("${arg.trim()}" is one). ` +
          'There is no shell — split this into separate exec_command calls, and use ' +
          'tail_lines, head_lines, max_output_chars, or output_stream instead of piping.',
      );
    }
  }
}

// ── PowerShell ban ─────────────────────────────────────────────────────────────

const PS_DANGEROUS_FLAGS = ['-Command', '-EncodedCommand', '-enc'];
/**
 * Every shell that runs a model-authored script string.
 *
 * `pwsh` is PowerShell 7 and was missing here, so `pwsh -Command <script>`
 * walked straight past a ban whose whole rationale is that such a script
 * cannot be checked by the denylist. Matching the launcher name is the point:
 * a new PowerShell binary is a new hole, not a variant of an old one.
 */
const PS_LAUNCHERS = ['powershell.exe', 'powershell', 'pwsh.exe', 'pwsh'];
const SCRIPT_LAUNCHERS = ['bash', 'sh', 'zsh', 'dash', 'cmd', 'cmd.exe', 'busybox'];
const SCRIPT_FLAGS = ['-c', '/c'];

export function checkPowerShellBan(command: string, args: string[]): void {
  // By basename: `/bin/bash` and a full `...\System32\cmd.exe` path are the same launchers.
  const cmd = (command.split(/[\\/]/).pop() ?? command).toLowerCase();
  if (
    SCRIPT_LAUNCHERS.includes(cmd) &&
    args.some((arg) => SCRIPT_FLAGS.includes(arg.toLowerCase()))
  ) {
    throw new Error(
      'Shell script flags are banned — a model-authored script cannot be checked by the denylist. ' +
        'Use a real executable with an args array or the dedicated filesystem tools instead.',
    );
  }
  if (PS_LAUNCHERS.includes(cmd)) {
    for (const arg of args) {
      if (PS_DANGEROUS_FLAGS.includes(arg)) {
        // Name the route that works. "Use a non-shell binary instead" told the
        // model what to stop doing and nothing about what to do, so it kept
        // hunting for another shell rather than reaching for the tool that
        // already does the job. The list named only READ tools, so a blocked
        // `Move-Item` sent the model to `robocopy /MOVE` instead of move_file —
        // every write route has to be named too.
        throw new Error(
          `PowerShell flag "${arg}" is banned — a model-authored script cannot be checked ` +
            'by the denylist, so it is never run. Use the dedicated tools instead: ' +
            'wait to pause for a number of seconds, list_directory to list files, ' +
            'read_file to read them, search_code to search, query_powershell for a ' +
            'read-only workspace overview or a file hash; to change the filesystem, ' +
            'write_file to create or overwrite a file, edit_file to modify one, ' +
            'move_file to move or rename a file or directory, create_directory to make ' +
            'one, delete_file to remove one; or exec_command with a real executable and ' +
            'an args array.',
        );
      }
    }
  }
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
import { normalizeSpawnCwd, type SpawnResult } from '../util/processSpawn';

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

// ── Output formatter ───────────────────────────────────────────────────────────

/** `run_tests` / `run_build` output: each stream bounded, keeping its end (see `storedStream`). */
export function formatOutput(result: SpawnResult): string {
  // Strip ANSI BEFORE slicing: codes inflate the char count and a mid-escape
  // slice would leave dangling garbage.
  let out = storedStream(result.stdout, MAX_OUTPUT_CHARS).text;
  if (result.stderr) {
    out += `\n[stderr]\n${storedStream(result.stderr, MAX_OUTPUT_CHARS).text}`;
  }
  out += `\n[exit code: ${result.exitCode ?? 'null'}]`;
  return out;
}

function filterExecOutput(
  text: string,
  options: ExecOutputOptions,
): { text: string; truncated: boolean } {
  const normalized = stripAnsi(text);
  const lines = normalized.endsWith('\n')
    ? normalized.slice(0, -1).split(/\r?\n/u)
    : normalized.split(/\r?\n/u);
  const selected =
    options.headLines !== undefined
      ? lines.slice(0, options.headLines)
      : options.tailLines !== undefined
        ? lines.slice(-options.tailLines)
        : lines;
  const shaped = selected.join('\n');
  const limit = options.maxChars ?? MAX_OUTPUT_CHARS;
  const clipped = options.tailLines !== undefined ? shaped.slice(-limit) : shaped.slice(0, limit);
  return { text: clipped, truncated: shaped.length > limit || selected.length < lines.length };
}

/** Share of an over-long stream kept from its start; the rest comes from its end. */
const STORED_HEAD_SHARE = 0.25;

/**
 * The returned copy of one stream: the full output, capped at `limit`.
 *
 * `limit` is the caller's `max_output_chars` when it gave one, otherwise the
 * retention bound. An over-long stream keeps its first quarter and its end,
 * with a marker where the middle was: a build or test run puts the failure
 * and the summary last, so a head-only cut returned the progress lines and
 * dropped the one part the model needed — which cost a re-run with
 * `tail_lines`. The dropped middle is unrecoverable — it is never stored
 * anywhere — so the note says so rather than implying it can be paged back.
 */
function storedStream(text: string, limit: number): { text: string; dropped: number } {
  const normalized = stripAnsi(text);
  if (normalized.length <= limit) return { text: normalized, dropped: 0 };
  const head = Math.floor(limit * STORED_HEAD_SHARE);
  const marker = `\n[… ${String(normalized.length - limit)} characters dropped …]\n`;
  const tail = limit - head - marker.length;
  if (tail < head) return { text: normalized.slice(0, limit), dropped: normalized.length - limit };
  return {
    text: normalized.slice(0, head) + marker + normalized.slice(-tail),
    dropped: normalized.length - limit,
  };
}

/** The note attached to a stream cut by the returned-character bound. */
function dropNote(dropped: number, limit: number, explicit: boolean): string {
  const bound = explicit
    ? `the max_output_chars value you passed (${String(limit)})`
    : `the ${String(limit)}-char default bound`;
  return (
    `${String(dropped)} characters from the middle, past ${bound}, were dropped and cannot be recovered. ` +
    `Re-run with head_lines or tail_lines to select the part you need, or redirect the ` +
    `command's output to a file and read it.`
  );
}

export function formatExecCommandOutput(
  program: string,
  result: SpawnResult,
  options: ExecOutputOptions = {},
): string {
  const stream = options.stream ?? 'both';
  // A line window (head/tail) IS the answer the caller asked for, so it is what
  // gets returned. Without one, the whole stream is returned, bounded by
  // `max_output_chars` when given and by the retention bound otherwise.
  const lineWindow = options.headLines !== undefined || options.tailLines !== undefined;
  const explicitLimit = options.maxChars !== undefined;
  const limit = options.maxChars ?? MAX_EXEC_STORED_CHARS;
  const out: Record<string, unknown> = {
    kind: result.exitCode === 0 ? 'success' : 'non_zero_exit',
    program,
    exitCode: result.exitCode,
  };
  const emit = (key: 'stdout' | 'stderr', raw: string): void => {
    if (lineWindow) {
      const shown = filterExecOutput(raw, options);
      out[key] = shown.text;
      out[`${key}_truncated`] = shown.truncated;
      return;
    }
    const stored = storedStream(raw, limit);
    out[key] = stored.text;
    if (stored.dropped > 0) {
      out[`${key}_truncated`] = true;
      out[`${key}_note`] = dropNote(stored.dropped, limit, explicitLimit);
    }
  };
  if (stream !== 'stderr') emit('stdout', result.stdout);
  if (stream !== 'stdout') emit('stderr', result.stderr);
  return JSON.stringify(out);
}

// ── Denylist guard ─────────────────────────────────────────────────────────────

export function guardExec(command: string, args: string[]): void {
  const denyEntry = checkDenyList(command, args, getBuiltinDenyList());
  if (denyEntry) {
    // Name the sanctioned route. A bare refusal left the agent to invent one,
    // and `delete_file` — which it is permitted to use — went uncalled across
    // roughly three thousand tool calls while it reached for the shell instead.
    const alternative = denyEntry.alternative ? ` ${denyEntry.alternative}` : '';
    throw new Error(`exec_command: blocked — ${denyEntry.description}.${alternative}`);
  }
}

// ── Test runner detection ──────────────────────────────────────────────────────

export interface TestRunnerConfig {
  command: string;
  baseArgs: string[];
}

export function detectTestRunner(workspaceRoot: string): TestRunnerConfig {
  const pkgPath = path.join(workspaceRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return { command: 'npm', baseArgs: ['test'] };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- package.json is untyped
  let pkg: any;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    return { command: 'npm', baseArgs: ['test'] };
  }

  const allDeps: Record<string, string> = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };

  if (allDeps['vitest']) return { command: 'npx', baseArgs: ['vitest', 'run'] };
  if (allDeps['jest']) return { command: 'npx', baseArgs: ['jest', '--no-coverage'] };
  if (allDeps['mocha']) return { command: 'npx', baseArgs: ['mocha'] };
  return { command: 'npm', baseArgs: ['test'] };
}
