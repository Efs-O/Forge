import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { checkDenyList, getBuiltinDenyList } from './DenyList';

export const MAX_OUTPUT_CHARS = 10_000;
export const MAX_EXEC_OUTPUT_LINES = 2_000;

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
  if (!cwd) return getWorkspaceRoot();
  if (path.isAbsolute(cwd)) return cwd;
  return path.join(getWorkspaceRoot(), cwd);
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

export function checkPowerShellBan(command: string, args: string[]): void {
  const cmd = command.toLowerCase();
  if (cmd === 'powershell.exe' || cmd === 'powershell') {
    for (const arg of args) {
      if (PS_DANGEROUS_FLAGS.includes(arg)) {
        // Name the route that works. "Use a non-shell binary instead" told the
        // model what to stop doing and nothing about what to do, so it kept
        // hunting for another shell rather than reaching for the tool that
        // already does the job.
        throw new Error(
          `PowerShell flag "${arg}" is banned — a model-authored script cannot be checked ` +
            'by the denylist, so it is never run. Use the dedicated tools instead: ' +
            'list_directory to list files, read_file to read them, search_code to search, ' +
            'query_powershell for a read-only workspace overview or a file hash, or ' +
            'exec_command with a real executable and an args array.',
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
  spawnAndWait,
  type ExecCommandErrorKind,
  type SpawnResult,
} from '../util/processSpawn';
import { type SpawnResult } from '../util/processSpawn';

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

export function formatOutput(result: SpawnResult): string {
  // Strip ANSI BEFORE slicing: codes inflate the char count and a mid-escape
  // slice would leave dangling garbage.
  let out = stripAnsi(result.stdout).slice(0, MAX_OUTPUT_CHARS);
  if (result.stderr) {
    out += `\n[stderr]\n${stripAnsi(result.stderr).slice(0, MAX_OUTPUT_CHARS)}`;
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

export function formatExecCommandOutput(
  program: string,
  result: SpawnResult,
  options: ExecOutputOptions = {},
): string {
  const stream = options.stream ?? 'both';
  const stdout = filterExecOutput(result.stdout, options);
  const stderr = filterExecOutput(result.stderr, options);
  return JSON.stringify({
    kind: result.exitCode === 0 ? 'success' : 'non_zero_exit',
    program,
    exitCode: result.exitCode,
    ...(stream !== 'stderr' ? { stdout: stdout.text, stdout_truncated: stdout.truncated } : {}),
    ...(stream !== 'stdout' ? { stderr: stderr.text, stderr_truncated: stderr.truncated } : {}),
  });
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
