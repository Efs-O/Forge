import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export const MAX_OUTPUT_CHARS = 16_000;
export const MAX_OUTPUT_CHARS_CEILING = 32_000;
export const MAX_EXEC_OUTPUT_LINES = 2_000;

/**
 * Upper bound on how much of a command's output is RETURNED, and therefore
 * stored in the transcript and paged by `read_tool_result`.
 *
 * There is no separate "shown" copy: what this function returns is what the
 * round carries. The excerptor in `toolResultContext` shrinks it further only
 * when the window is actually tight, so this bound is the real worst case a
 * single `background execution` can add — both streams at once, which at ~4 chars per
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

export function getWorkspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) throw new Error('No workspace folder open');
  return folders[0].uri.fsPath;
}

export function resolveExecCwd(cwd: string | undefined): string {
  // normalizeSpawnCwd here as well as at the spawn, so the cwd reported back to
  // the model is the same spelling the process actually ran under.
  const resolved = normalizeSpawnCwd(
    !cwd ? getWorkspaceRoot() : path.isAbsolute(cwd) ? cwd : path.join(getWorkspaceRoot(), cwd),
  );
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    throw new Error(
      `shell: cwd ${JSON.stringify(cwd ?? resolved)} does not exist (resolved to ${resolved}). ` +
        'Create it first (create_directory, or mkdir in the command) or leave cwd out.',
    );
  }
  if (!stat.isDirectory()) {
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
  const explicitLimit = options.maxCharsExplicit ?? options.maxChars !== undefined;
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
