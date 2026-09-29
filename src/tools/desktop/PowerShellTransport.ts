/**
 * The real desktop transport (plan §4.5, §9). Writes the bundled
 * `desktopDriver.ps1` to a temp file and spawns `pwsh -File <temp>` (falling
 * back to Windows PowerShell 5.1). No script-text interpolation — requests are
 * JSON lines on stdin to the fixed script; responses are JSON lines on stdout,
 * correlated by `id`.
 *
 * B3: `dispose()` sends the `dispose` op (the driver treats it as release-all),
 * waits ~500 ms for the ack, kills the child, and spawns a one-shot `-ReleaseAll`
 * if the child never acked — so a held key/button is released on teardown.
 */
import { spawn, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import driverScript from './desktopDriver.ps1';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The minimal driver<->process contract. Tests inject a fake. */
export interface DesktopTransport {
  send(op: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Release-all, wait for the ack, kill the child, one-shot backstop. */
  dispose(): Promise<void>;
}

/** No driver op legitimately takes this long; a hung request fails instead of the turn. */
const REQUEST_TIMEOUT_MS = 60_000;
const STDERR_TAIL_CHARS = 2000;

export class PowerShellTransport implements DesktopTransport {
  private child: ChildProcess | undefined;
  /** The executable that actually started (pwsh, or the 5.1 fallback). */
  private executable = 'pwsh';
  private scriptPath: string | undefined;
  private stderrTail = '';
  private counter = 0;
  private disposed = false;
  private readonly pending = new Map<
    number,
    { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
  >();
  private startPromise: Promise<void> | undefined;
  private exitPromise: Promise<void> = Promise.resolve();

  constructor(
    private readonly scriptSource: string = driverScript,
    private readonly requestTimeoutMs: number = REQUEST_TIMEOUT_MS,
  ) {}

  private async ensureStarted(): Promise<void> {
    if (this.disposed) throw new Error('desktop driver is disposed');
    // A crashed/killed child clears startPromise in its exit handler, so the
    // next request respawns instead of the singleton staying dead until reload.
    if (!this.startPromise) {
      this.startPromise = this.start().catch((err: unknown) => {
        this.startPromise = undefined;
        throw err;
      });
    }
    await this.startPromise;
  }

  private args(extra: string[] = []): string[] {
    const script = this.scriptPath as string;
    return [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      ...extra,
    ];
  }

  private async start(): Promise<void> {
    if (!this.scriptPath) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-desktop-'));
      this.scriptPath = path.join(dir, `driver-${randomBytes(4).toString('hex')}.ps1`);
      await fs.writeFile(this.scriptPath, this.scriptSource, 'utf8');
    }
    let child: ChildProcess;
    try {
      child = await this.spawnStarted('pwsh', this.args());
      this.executable = 'pwsh';
    } catch (err) {
      // `pwsh` (PowerShell 7) absent -> fall back to Windows PowerShell 5.1.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`desktop driver spawn failed: ${(err as Error).message}`);
      }
      child = await this.spawnStarted('powershell', this.args());
      this.executable = 'powershell';
    }
    this.child = child;
    this.stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      // Drain stderr (an undrained pipe blocks the driver) and keep the tail
      // so an exit names the PowerShell error instead of a bare "exited".
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
    });
    this.exitPromise = new Promise((resolve) => {
      child.on('exit', (code) => {
        if (this.child === child) {
          this.child = undefined;
          this.startPromise = undefined;
        }
        const tail = this.stderrTail.trim();
        this.failAll(
          new Error(`desktop driver process exited (code ${code})${tail ? `: ${tail}` : ''}`),
        );
        resolve();
      });
    });
    child.on('error', (err) => this.failAll(new Error(`desktop driver error: ${err.message}`)));
    // Writing to a child that just exited raises EPIPE on stdin; unhandled, that
    // is an uncaught exception in the extension host. The exit handler reports it.
    child.stdin?.on('error', (err) =>
      this.failAll(new Error(`desktop driver stdin closed: ${err.message}`)),
    );
    if (child.stdout) {
      readline
        .createInterface({ input: child.stdout, crlfDelay: Infinity })
        .on('line', (line) => this.handleLine(line));
    }
  }

  /** Spawn and wait until the OS reports it started (or failed to, e.g. ENOENT). */
  private spawnStarted(executable: string, args: string[]): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      const child = this.spawn(executable, args);
      child.once('spawn', () => resolve(child));
      child.once('error', reject);
    });
  }

  private spawn(executable: string, args: string[]): ChildProcess {
    return spawn(executable, args, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Non-JSON stdout (a stray Write-Host) is not a response; the request it
      // might belong to is still bounded by the per-request timeout.
      return;
    }
    const id = typeof parsed['id'] === 'number' ? (parsed['id'] as number) : -1;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (parsed['ok'] === false) {
      entry.reject(
        new Error(
          str(parsed['reason']) || str(parsed['error']) || 'desktop driver refused the operation',
        ),
      );
    } else {
      entry.resolve(parsed);
    }
  }

  async send(op: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ensureStarted();
    const id = ++this.counter;
    const line = JSON.stringify({ ...op, id });
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(
          new Error(
            `desktop driver: "${String(op.op)}" timed out after ${this.requestTimeoutMs} ms`,
          ),
        );
        // A hung driver's state (held button, attached input) is unknown: kill it
        // and release everything; the next request respawns a clean driver.
        this.child?.kill();
        void this.oneShotReleaseAll();
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child?.stdin?.write(`${line}\n`, (err) => {
        const entry = this.pending.get(id);
        if (err && entry) {
          this.pending.delete(id);
          entry.reject(new Error(`desktop driver write failed: ${err.message}`));
        }
      });
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    const child = this.child;
    let acked = false;
    if (child) {
      try {
        await Promise.race([
          this.send({ op: 'dispose' }),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error('dispose ack timeout')), 500),
          ),
        ]);
        acked = true;
      } catch {
        acked = false; // no ack: the one-shot below releases instead
      }
    }
    this.disposed = true;
    if (child) {
      child.kill();
      await Promise.race([this.exitPromise, new Promise((r) => setTimeout(r, 500))]);
    }
    if (!acked) await this.oneShotReleaseAll();
    this.failAll(new Error('desktop driver disposed'));
    await this.cleanup();
  }

  private async oneShotReleaseAll(): Promise<void> {
    if (!this.scriptPath) return;
    await new Promise<void>((resolve) => {
      const oneShot = this.spawn(this.executable, this.args(['-ReleaseAll']));
      oneShot.on('error', () => resolve());
      oneShot.on('exit', () => resolve());
      setTimeout(resolve, 2000);
    });
  }

  private async cleanup(): Promise<void> {
    if (this.scriptPath) {
      const dir = path.dirname(this.scriptPath);
      this.scriptPath = undefined;
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  private failAll(err: Error): void {
    for (const entry of this.pending.values()) entry.reject(err);
    this.pending.clear();
  }
}
