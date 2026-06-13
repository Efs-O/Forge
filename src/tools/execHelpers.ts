import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { checkDenyList, getBuiltinDenyList } from './DenyList';

export const MAX_OUTPUT_CHARS = 10_000;

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

const SHELL_OPERATORS = ['&&', '||', ';', '|', '`', '$(', '>', '<'];

export function checkShellOperators(args: string[]): void {
  for (const arg of args) {
    for (const op of SHELL_OPERATORS) {
      if (arg.includes(op)) {
        throw new Error(
          'Shell operators are not permitted in arguments. Split into separate tool calls.',
        );
      }
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
        throw new Error(
          `PowerShell flag "${arg}" is banned. Use exec_command with a non-shell binary instead.`,
        );
      }
    }
  }
}

// ── Core spawn helper ──────────────────────────────────────────────────────────

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export function spawnAndWait(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const proc = child_process.spawn(command, args, {
      shell: false,
      cwd,
      // Suppress terminal color at the source so most tools (vitest, npm, …)
      // emit no ANSI. NOT CI=true — that changes some runners' semantics.
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`exec_command: spawn error — ${err.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`exec_command: process timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

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

// ── Denylist guard ─────────────────────────────────────────────────────────────

export function guardExec(command: string, args: string[]): void {
  const denyEntry = checkDenyList(command, args, getBuiltinDenyList());
  if (denyEntry) {
    throw new Error(`exec_command: blocked — ${denyEntry.description}`);
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
  if (allDeps['jest'])   return { command: 'npx', baseArgs: ['jest', '--no-coverage'] };
  if (allDeps['mocha'])  return { command: 'npx', baseArgs: ['mocha'] };
  return { command: 'npm', baseArgs: ['test'] };
}
