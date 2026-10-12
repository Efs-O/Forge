import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { terminateProcessTree } from '../../agents/cliProcess';
import { RollingOutputCap } from '../../util/outputCap';
import { normalizeSpawnCwd } from '../../util/processSpawn';

/**
 * The one-shot `sd-cli -M upscale` child behind `upscale_image`.
 *
 * Owned apart from the tool so the process lifecycle — spawn env, the abort and
 * timeout paths, and the promise that the child is actually gone before the
 * caller deletes a partial output — can be tested against a real process, on
 * any platform, without a GPU. The rule that makes that testable (and is the
 * whole point of the design): Forge kills the PID **it** spawned, never a
 * process matched by name, and it waits for the exit before resolving, so a
 * caller that deletes the output afterwards cannot race a still-writing child.
 *
 * argv construction lives here too, exported as its own function, because a
 * wrong flag in a one-shot GPU job is invisible in the result — the image just
 * comes back at the wrong size or not at all.
 */

/** `sd-cli` argv for one ×4 pass. Split out so the flag mapping is assertable. */
export function upscaleArgv(model: string, inputPath: string, outputPath: string): string[] {
  return ['-M', 'upscale', '--upscale-model', model, '-i', inputPath, '-o', outputPath];
}

export type UpscaleFailureKind = 'cancelled' | 'timeout' | 'spawn_error' | 'exit';

export interface UpscaleSpawnSpec {
  /** Absolute path to `sd-cli` / `sd-cli.exe`. */
  binary: string;
  args: string[];
  /** CUDA ordinal, applied as `CUDA_VISIBLE_DEVICES` (the sdcpp backend's ordering). */
  cudaDevice: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface UpscaleRunResult {
  /** True only for a clean exit 0. A failure never falls back to anything. */
  ok: boolean;
  /** Set whenever `ok` is false. */
  kind?: UpscaleFailureKind;
  exitCode: number | null;
  /** Bounded stderr (head+tail), trimmed; '' when the child said nothing. */
  stderr: string;
  /** The PID Forge spawned, when a child was started at all. */
  pid?: number;
  /**
   * True when the child is known to be gone. The abort and timeout paths wait
   * for the exit event before resolving, precisely so the caller's cleanup of a
   * partial output cannot run while the process still holds the file open.
   */
  processGone: boolean;
}

/** Injectable seam mirroring `sdcppReferenceInput.RunFfmpeg`: tests drive this, production spawns. */
export type UpscaleRun = (spec: UpscaleSpawnSpec) => Promise<UpscaleRunResult>;

/** Bound on retained stderr. sd-cli prints per-tile diagnostics on some builds. */
const STDERR_BUDGET_CHARS = 4_000;

/**
 * Spawn one upscaler pass and collect its output.
 *
 * `cwd` is the binary's own folder: `sd-cli` loads its CUDA DLLs from beside
 * the executable, and the same choice `spawnAndWait` makes for every other
 * Forge child. `shell: false`, always, and the CUDA device is pinned through
 * the environment rather than a flag, so the process cannot drift onto the card
 * the display is using.
 */
export function runUpscale(spec: UpscaleSpawnSpec): Promise<UpscaleRunResult> {
  return new Promise((resolve) => {
    const stderrCap = new RollingOutputCap(STDERR_BUDGET_CHARS);
    const stdoutCap = new RollingOutputCap(STDERR_BUDGET_CHARS);
    let settled = false;
    let killRequested: UpscaleFailureKind | undefined;

    // Nothing was started, so nothing needs killing: an already-aborted turn
    // costs no process at all.
    if (spec.signal?.aborted) {
      resolve({ ok: false, kind: 'cancelled', exitCode: null, stderr: '', processGone: true });
      return;
    }

    let started: ChildProcess;
    try {
      started = spawn(spec.binary, spec.args, {
        shell: false,
        cwd: normalizeSpawnCwd(path.dirname(spec.binary)),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, CUDA_VISIBLE_DEVICES: String(spec.cudaDevice), NO_COLOR: '1' },
        // NOT detached on purpose. `sd-cli` is one native process that forks
        // nothing, so grouping buys no extra kill — and a group leader survives
        // an extension-host crash, which would leave an orphan holding VRAM and
        // still writing `_x4.png`. Un-grouped, terminateProcessTree signals the
        // direct child by PID (its POSIX fallback) and the plan's ledger cell
        // ("child dies with the extension host") stays true.
      });
    } catch (error) {
      resolve({
        ok: false,
        kind: 'spawn_error',
        exitCode: null,
        stderr: error instanceof Error ? error.message : String(error),
        processGone: true,
      });
      return;
    }
    const child = started;
    const timer = setTimeout(() => terminate('timeout'), spec.timeoutMs);

    const finish = (result: UpscaleRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      spec.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const collected = (): string => {
      const err = stderrCap.text().trim();
      const out = stdoutCap.text().trim();
      // sd-cli writes its progress to stdout and its errors to stderr. Lead with
      // stderr, and keep the tail: the failing tile or the missing model is last.
      if (err) return err.length > 1_200 ? `…${err.slice(-1_200)}` : err;
      if (out) return out.length > 1_200 ? `…${out.slice(-1_200)}` : out;
      return '';
    };
    /** Kill this exact PID's tree, then wait for the exit event before resolving. */
    function terminate(kind: UpscaleFailureKind): void {
      if (killRequested || settled) return;
      killRequested = kind;
      void terminateProcessTree(child).then(() => {
        // The exit event usually lands first and has already resolved; this is
        // the backstop for a child that dies without emitting one.
        finish({
          ok: false,
          kind,
          exitCode: child.exitCode,
          stderr: collected(),
          ...(child.pid ? { pid: child.pid } : {}),
          processGone: true,
        });
      });
    }
    const onAbort = (): void => terminate('cancelled');
    spec.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => stdoutCap.append(chunk));
    child.stderr?.on('data', (chunk: string) => stderrCap.append(chunk));
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        kind: error.code === 'ENOENT' ? 'spawn_error' : 'exit',
        exitCode: null,
        stderr: error.message,
        ...(child.pid ? { pid: child.pid } : {}),
        processGone: true,
      });
    });
    child.on('close', (code) => {
      if (killRequested) {
        finish({
          ok: false,
          kind: killRequested,
          exitCode: code,
          stderr: collected(),
          ...(child.pid ? { pid: child.pid } : {}),
          processGone: true,
        });
        return;
      }
      finish({
        ok: code === 0,
        ...(code === 0 ? {} : { kind: 'exit' as const }),
        exitCode: code,
        stderr: collected(),
        ...(child.pid ? { pid: child.pid } : {}),
        processGone: true,
      });
    });
  });
}
