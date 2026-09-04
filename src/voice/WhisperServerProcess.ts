import { spawn, type ChildProcess } from 'child_process';
import { access } from 'fs/promises';
import { terminateProcessTree } from '../agents/cliProcess';
import type { WhisperCppOptions } from './WhisperCppRunner';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8092;
const DEFAULT_IDLE_TIMEOUT_MS = 600_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;

export interface WhisperServerProcessOptions extends Omit<
  WhisperCppOptions,
  'timeoutMs' | 'binary'
> {
  readonly binary: string;
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly idleTimeoutMs?: number | undefined;
  readonly startupTimeoutMs?: number | undefined;
  readonly confirmOnStart?: boolean | undefined;
  readonly confirmStart?: ((detail: string) => Promise<boolean>) | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  readonly spawnFn?: ((binary: string, args: string[]) => ChildProcess) | undefined;
  readonly terminateFn?: ((process: ChildProcess) => Promise<void>) | undefined;
}

export function composeWhisperServerArgs(options: WhisperServerProcessOptions): string[] {
  const args = [
    '-m',
    options.model,
    '--host',
    options.host ?? DEFAULT_HOST,
    '--port',
    String(options.port ?? DEFAULT_PORT),
  ];
  if (options.useGpu === false) args.push('-ng');
  else if (options.gpuDevice !== undefined) args.push('-dev', String(options.gpuDevice));
  if (options.threads !== undefined) args.push('-t', String(options.threads));
  if (options.beamSize !== undefined) args.push('-bs', String(options.beamSize));
  if (options.flashAttn !== undefined) args.push(options.flashAttn ? '-fa' : '-nfa');
  return args;
}

/** Owns one resident whisper-server and its idle/disposal lifecycle. */
export class WhisperServerProcess {
  private process: ChildProcess | undefined;
  private startPromise: Promise<void> | undefined;
  private startAbort: AbortController | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private activeUses = 0;
  private disposed = false;

  constructor(private readonly options: WhisperServerProcessOptions) {}

  baseUrl(): string {
    return `http://${this.options.host ?? DEFAULT_HOST}:${this.options.port ?? DEFAULT_PORT}`;
  }

  async withActivity<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error('whisper-server process is disposed');
    this.activeUses++;
    this.clearIdleTimer();
    try {
      await this.start();
      return await operation();
    } finally {
      this.activeUses--;
      this.scheduleIdleStop();
    }
  }

  async start(): Promise<void> {
    if (this.disposed) throw new Error('whisper-server process is disposed');
    if (this.process && !this.startPromise) return;
    if (this.startPromise) return this.startPromise;
    const pending = this.startInternal();
    this.startPromise = pending;
    try {
      await pending;
    } finally {
      if (this.startPromise === pending) this.startPromise = undefined;
    }
  }

  private async startInternal(): Promise<void> {
    await this.assertReadable(this.options.binary, 'voice.server.binary');
    await this.assertReadable(this.options.model, 'voice.whisper_model');
    if (this.disposed) throw new Error('whisper-server process is disposed');
    if (await this.probe()) {
      throw new Error(
        `voice.server.port ${this.options.port ?? DEFAULT_PORT} is already in use; ` +
          'Forge will not adopt an externally started whisper-server',
      );
    }
    if (this.options.confirmOnStart !== false) {
      if (!this.options.confirmStart) {
        throw new Error('voice.server requires start confirmation, but no confirmer is available');
      }
      const timeout = this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
      const approved = await this.options.confirmStart(
        'Forge will start whisper-server and keep the speech model in VRAM ' +
          `(about 3.6 GB)${timeout === 0 ? ' until this window closes' : ` for ${Math.round(timeout / 1000)} seconds after the last voice note`}.`,
      );
      if (!approved) throw new Error('whisper-server start was cancelled');
    }
    // Disposal can happen while the modal confirmation is open. Recheck before
    // spawning so a window close cannot create an orphan after teardown.
    if (this.disposed) throw new Error('whisper-server process is disposed');

    const args = composeWhisperServerArgs(this.options);
    const spawnFn =
      this.options.spawnFn ??
      ((binary: string, spawnArgs: string[]) =>
        spawn(binary, spawnArgs, {
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        }));
    const child = spawnFn(this.options.binary, args);
    this.process = child;
    this.startAbort = new AbortController();
    let output = '';
    let startupFailure: Error | undefined;
    const append = (chunk: Buffer): void => {
      output = `${output}${chunk.toString('utf8')}`.slice(-4096);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.once('error', (error) => {
      startupFailure = error;
    });
    child.once('exit', (code) => {
      if (this.process === child) this.process = undefined;
      startupFailure = new Error(`exited ${code ?? 'without a code'}`);
    });

    const deadline = Date.now() + (this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
    try {
      while (!this.startAbort.signal.aborted && Date.now() < deadline) {
        if (startupFailure || child.exitCode !== null) {
          throw new Error(
            `whisper-server failed to start: ${startupFailure?.message ?? `exited ${child.exitCode}`}${output.trim() ? ` — ${output.trim()}` : ''}`,
          );
        }
        if (await this.probe(this.startAbort.signal)) {
          this.startAbort = undefined;
          return;
        }
        await delay(100, this.startAbort.signal);
      }
      throw new Error(
        `whisper-server did not become ready within ${this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS} ms${output.trim() ? ` — ${output.trim()}` : ''}`,
      );
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.clearIdleTimer();
    this.startAbort?.abort();
    this.startAbort = undefined;
    const child = this.process;
    this.process = undefined;
    if (child) await (this.options.terminateFn ?? terminateProcessTree)(child);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stop();
  }

  private async assertReadable(target: string, key: string): Promise<void> {
    try {
      await access(target);
    } catch {
      throw new Error(`${key} not found: ${target}`);
    }
  }

  private async probe(signal?: AbortSignal): Promise<boolean> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), 1_000);
    try {
      await (this.options.fetchFn ?? fetch)(this.baseUrl(), {
        method: 'GET',
        signal: controller.signal,
      });
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private scheduleIdleStop(): void {
    this.clearIdleTimer();
    const timeout = this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    if (!this.process || this.activeUses > 0 || timeout === 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.activeUses === 0) void this.stop();
    }, timeout);
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
