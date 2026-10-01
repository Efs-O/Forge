import type { ChildProcess } from 'child_process';
import type * as vscode from 'vscode';

const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 250;
const PROBE_TIMEOUT_MS = 3_000;
const STDERR_TAIL_LINES = 20;

export class SdServerReadiness {
  private stderrPending = '';
  private readonly stderrTail: string[] = [];
  private processError: string | undefined;

  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly capabilitiesUrl: string,
    private readonly output: vscode.OutputChannel,
    private readonly now: () => number,
  ) {}

  attach(child: ChildProcess): void {
    child.stderr?.on('data', (chunk: Buffer | string) => this.captureStderr(String(chunk)));
    child.once('exit', () => this.flushStderr());
    child.once('error', (error: Error) => {
      this.processError = error.message;
      this.output.appendLine(`[process error] ${error.message}`);
    });
  }

  async probe(signal?: AbortSignal): Promise<{ answers: boolean; ready: boolean; status: number }> {
    const response = await this.fetchImpl(this.capabilitiesUrl, {
      method: 'GET',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)])
        : AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return { answers: true, ready: response.ok, status: response.status };
  }

  async waitUntilReady(child: ChildProcess, signal: AbortSignal): Promise<void> {
    const deadline = this.now() + READY_TIMEOUT_MS;
    let lastError = `server did not answer GET ${this.capabilitiesUrl}`;
    while (this.now() < deadline) {
      if (this.processError) throw new Error(`sd-server failed to spawn: ${this.processError}`);
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`sd-server exited during startup: ${this.stderrSummary() || lastError}`);
      }
      try {
        const result = await this.probe(signal);
        if (result.ready) return;
        lastError = `GET ${this.capabilitiesUrl} returned HTTP ${result.status}`;
      } catch (error) {
        lastError = errorMessage(error);
      }
      await delay(READY_POLL_MS, signal);
    }
    const stderr = this.stderrSummary();
    throw new Error(
      `sd-server readiness timed out after ${READY_TIMEOUT_MS}ms: ${lastError}` +
        `${stderr ? `; stderr: ${stderr}` : ''}`,
    );
  }

  startFailure(error: unknown): Error {
    this.flushStderr();
    const cause = errorMessage(error);
    const stderr = this.stderrSummary();
    return new Error(
      `${cause}${stderr && !cause.includes(stderr) ? `; last sd-server stderr:\n${stderr}` : ''}`,
    );
  }

  private captureStderr(text: string): void {
    this.stderrPending += text;
    const lines = this.stderrPending.split(/\r?\n/);
    this.stderrPending = lines.pop() ?? '';
    for (const line of lines) this.keepStderrLine(line);
  }

  private flushStderr(): void {
    if (!this.stderrPending) return;
    this.keepStderrLine(this.stderrPending);
    this.stderrPending = '';
  }

  private keepStderrLine(line: string): void {
    this.output.appendLine(line);
    this.stderrTail.push(line);
    if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
  }

  private stderrSummary(): string {
    return [...this.stderrTail, ...(this.stderrPending ? [this.stderrPending] : [])].join('\n');
  }
}

export function isConnectionRefused(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('code' in error && error.code === 'ECONNREFUSED') return true;
  if ('cause' in error && isConnectionRefused(error.cause)) return true;
  if ('errors' in error && Array.isArray(error.errors)) {
    return error.errors.some((nested: unknown) => isConnectionRefused(nested));
  }
  return false;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('sd-server startup was cancelled.'));
      return;
    }
    const finish = (): void => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason ?? new Error('sd-server startup was cancelled.'));
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
