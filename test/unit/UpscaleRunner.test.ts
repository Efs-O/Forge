import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runUpscale, upscaleArgv } from '../../src/tools/imageGeneration/upscaleRunner';

/**
 * The one-shot `sd-cli` lifecycle, driven against a REAL child (`node`, standing
 * in for sd-cli) so the two rules the plan makes acceptance criteria are proven
 * on a process rather than on a fake: the abort/timeout path kills the PID Forge
 * spawned — never a process matched by name — and it waits for the exit before
 * resolving, so the caller's delete of a partial output cannot race a writer.
 */

const NODE = process.execPath;

/** A child that writes a partial output, says so, then runs until killed. */
const HANG_SCRIPT =
  'require("fs").writeFileSync(process.argv[2],"half-write");' +
  'console.error("started");' +
  'setInterval(() => {}, 1000);';

/** A child that reports the env and argv it received, then exits 0. */
const REPORT_SCRIPT =
  'console.error(JSON.stringify({cuda: process.env.CUDA_VISIBLE_DEVICES, argv: process.argv.slice(2)}));';

let root: string;

beforeEach(async () => {
  // realpath, so paths the test builds and paths the tool resolves agree: on
  // Windows a temp dir can come back under an 8.3 short name.
  const made = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-upscale-runner-'));
  root = await fs.realpath(made);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function hangScript(): Promise<string> {
  const script = path.join(root, 'hang.cjs');
  await fs.writeFile(script, HANG_SCRIPT);
  return script;
}

/** True when a process with that PID still exists (ESRCH means gone). */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

describe('upscaleRunner argv', () => {
  it('is exactly the plan’s sd-cli upscale command', () => {
    expect(upscaleArgv('/m/4x_foolhardy_Remacri.pth', '/in/shot.png', '/in/shot_x4.png')).toEqual([
      '-M',
      'upscale',
      '--upscale-model',
      '/m/4x_foolhardy_Remacri.pth',
      '-i',
      '/in/shot.png',
      '-o',
      '/in/shot_x4.png',
    ]);
  });
});

describe('upscaleRunner process lifecycle', () => {
  it('pins CUDA_VISIBLE_DEVICES and passes argv through without a shell', async () => {
    const script = path.join(root, 'report.cjs');
    await fs.writeFile(script, REPORT_SCRIPT);
    const result = await runUpscale({
      binary: NODE,
      args: [script, '--flag', 'with a space'],
      cudaDevice: 3,
      timeoutMs: 20_000,
    });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    // The child's own words, kept by the runner: what it saw for CUDA, and the
    // argv it was handed.
    const reported = JSON.parse(result.stderr) as { cuda: string; argv: string[] };
    expect(reported.cuda).toBe('3');
    // `shell: false` is what lets an argument keep its space instead of being
    // re-split by a shell.
    expect(reported.argv).toEqual(['--flag', 'with a space']);
  });

  it('abort kills the spawned PID and leaves a partial file the caller can delete', async () => {
    const script = await hangScript();
    const partial = path.join(root, 'shot_x4.png');
    const abort = new AbortController();
    const running = runUpscale({
      binary: NODE,
      args: [script, partial],
      cudaDevice: 0,
      timeoutMs: 20_000,
      signal: abort.signal,
    });
    // Wait for the child's partial write, so the kill is proven to land on a
    // process that was really working, not on one that never started.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if ((await fs.stat(partial)).size > 0) break;
      } catch {
        // not written yet
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    abort.abort();
    const result = await running;
    expect(result.kind).toBe('cancelled');
    expect(result.processGone).toBe(true);
    expect(typeof result.pid).toBe('number');
    // What `processGone` claims, checked on the OS: the PID Forge spawned is
    // gone, so the caller's delete cannot race it.
    expect(processIsAlive(result.pid!)).toBe(false);
    await fs.rm(partial, { force: true });
    await expect(fs.stat(partial)).rejects.toThrow(/ENOENT/);
  });

  it('kills on timeout with the same guarantee, and says what the child printed', async () => {
    const script = await hangScript();
    const partial = path.join(root, 'late_x4.png');
    const startedAt = Date.now();
    const result = await runUpscale({
      binary: NODE,
      args: [script, partial],
      cudaDevice: 0,
      timeoutMs: 400,
    });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300);
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('timeout');
    expect(result.processGone).toBe(true);
    expect(result.stderr).toContain('started');
    expect(processIsAlive(result.pid!)).toBe(false);
  });

  it('reports a spawn error rather than throwing, so the tool can name the fix', async () => {
    const result = await runUpscale({
      binary: path.join(root, 'definitely-not-here.exe'),
      args: [],
      cudaDevice: 0,
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('spawn_error');
    expect(result.processGone).toBe(true);
    expect(result.stderr).toMatch(/ENOENT|no such file/i);
  });

  it('reports a nonzero exit with the child’s stderr, and never retries', async () => {
    const marker = path.join(root, 'attempts.txt');
    const result = await runUpscale({
      binary: NODE,
      args: [
        '-e',
        `require("fs").appendFileSync(${JSON.stringify(marker)},"x");` +
          'console.error("model missing"); process.exit(1)',
      ],
      cudaDevice: 0,
      timeoutMs: 20_000,
    });
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('exit');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('model missing');
    expect(await fs.readFile(marker, 'utf8')).toBe('x');
  });

  it('returns cancelled without spawning when the signal is already aborted', async () => {
    const result = await runUpscale({
      binary: NODE,
      args: ['-e', 'console.log("ran")'],
      cudaDevice: 0,
      timeoutMs: 20_000,
      signal: AbortSignal.abort(),
    });
    expect(result.kind).toBe('cancelled');
    expect(result.pid).toBeUndefined();
    expect(result.stderr).toBe('');
  });
});
