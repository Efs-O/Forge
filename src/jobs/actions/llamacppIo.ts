import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { updateConfigFile, setNestedField } from '../../config/ConfigWriter';

/**
 * The real (machine-touching) I/O for the `llamacpp_update` action (B5). Kept
 * apart from `llamacppUpdate.ts` so the pipeline is testable with fakes and the
 * spawn / PowerShell / crypto calls live in one place. Every function here is
 * injected into the action env by `jobsSetup.ts`.
 */

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run a command and collect its output. Resolves with `{code, stdout, stderr}`
 * on exit (code may be non-zero) and on timeout (code null, a `[timeout]` note
 * appended to stderr). Rejects only when the process cannot start at all.
 */
export function runCommand(
  binary: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(binary, args, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        if (process.platform === 'win32' && proc.pid) {
          spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        } else {
          proc.kill('SIGKILL');
        }
      } catch {
        // best-effort kill
      }
      finish({ code: null, stdout, stderr: `${stderr}\n[timeout after ${timeoutMs}ms]` });
    }, timeoutMs);
    proc.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    proc.on('exit', (code) => finish({ code, stdout, stderr }));
  });
}

/** SHA-256 (lowercase hex) of a file, streamed. */
export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (d: string | Buffer) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Extract a zip into a directory using PowerShell's `Expand-Archive` (Windows).
 * The llama.cpp release zips extract flat (no nested top-level folder), so the
 * `llama-server.exe` lands directly in `destDir`.
 */
export function extractZip(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const quote = (s: string): string => `'${s.replace(/'/g, "''")}'`;
    const command = `Expand-Archive -LiteralPath ${quote(zipPath)} -DestinationPath ${quote(
      destDir,
    )} -Force`;
    const proc = spawn(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Expand-Archive failed (code ${code}): ${stderr.slice(0, 300)}`));
    });
  });
}

/**
 * A `setBinary` that writes only `llama_server.binary` in config.yaml,
 * preserving comments and key order (via the comment-preserving writer).
 * Passing `undefined` deletes the field (the post-check restore when there was
 * no prior binary), so the config is never left pointing at a broken build.
 */
export function makeSetBinary(configPath: string): (binary: string | undefined) => void {
  return (binary: string | undefined): void => {
    updateConfigFile(configPath, (doc) => setNestedField(doc, ['llama_server', 'binary'], binary));
  };
}
