import * as child_process from 'child_process';
import { terminateCliProcessTree } from '../agents/cliProcess';

/**
 * Canonical `spawn`-and-collect primitive. Lives here rather than in
 * `tools/execHelpers.ts` because that module imports `vscode`, and callers like
 * `tools/videoExtract.ts` must stay unit-testable outside the extension host.
 * `execHelpers` re-exports these names, so existing importers are unaffected.
 */
export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type ExecCommandErrorKind =
  | 'missing_executable'
  | 'timeout'
  | 'cancelled'
  | 'spawn_error'
  | 'invalid_shell_syntax'
  | 'policy_refusal';

export class ExecCommandError extends Error {
  constructor(
    readonly kind: ExecCommandErrorKind,
    readonly program: string,
    detail: string,
  ) {
    // Prose, not JSON. This message is read by the model as the result of the
    // call it just made -- the highest-salience prompt in the system -- and a
    // serialized object taught it nothing. `kind` and `program` remain
    // properties for code; they were noise in the string.
    super(`${program}: ${detail}`);
    this.name = 'ExecCommandError';
  }
}

/**
 * Canonical spawn `cwd` normaliser. VS Code's `Uri.fsPath` lower-cases the
 * Windows drive letter, so a workspace on `N:` arrives as `n:\...`. Node spawns
 * that happily, but tools that resolve module ids against `cwd` — anything on
 * Vite, vitest included — then key the same file under two spellings and load
 * two copies of their own module graph. vitest fails every file at `describe`
 * with "Cannot read properties of undefined (reading 'config')", which looks
 * like a broken test file and is really a broken path.
 *
 * Every spawn goes through here, so no caller has to remember this.
 */
export function normalizeSpawnCwd(cwd: string): string {
  if (process.platform !== 'win32') return cwd;
  return /^[a-z]:/u.test(cwd) ? cwd[0].toUpperCase() + cwd.slice(1) : cwd;
}

export function spawnAndWait(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  extraEnv: NodeJS.ProcessEnv = {},
  signal?: AbortSignal,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const proc = child_process.spawn(command, args, {
      shell: false,
      cwd: normalizeSpawnCwd(cwd),
      // Suppress terminal color at the source so most tools (vitest, npm, …)
      // emit no ANSI. NOT CI=true — that changes some runners' semantics.
      env: { ...process.env, ...extraEnv, NO_COLOR: '1', FORCE_COLOR: '0' },
    });

    const finish = (result: SpawnResult | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    const terminate = (): void => {
      // npm/npx often launch a shell shim then a Node process. Killing only
      // the shim leaves the test runner alive and its stdio open forever.
      void terminateCliProcessTree(proc);
    };
    const onAbort = (): void => {
      terminate();
      finish(new ExecCommandError('cancelled', command, 'process cancelled'));
    };
    const timer = setTimeout(() => {
      terminate();
      finish(new ExecCommandError('timeout', command, `process timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      finish(
        new ExecCommandError(
          err.code === 'ENOENT' ? 'missing_executable' : 'spawn_error',
          command,
          err.message,
        ),
      );
    });

    proc.on('close', (code) => {
      finish({ stdout, stderr, exitCode: code });
    });
  });
}
