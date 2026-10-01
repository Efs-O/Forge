import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import type { ForgeConfig, ModelConfig } from '../config/types';

/**
 * Mirrors the log file of a server Forge does not spawn (Strata, a hand-started
 * llama-server) into an output channel, so its per-request speed lines are
 * visible inside VS Code. One follower per distinct `server_log` path; a model
 * entry opts in with that field.
 *
 * Polls with stat rather than fs.watch: the writer is another process, and
 * fs.watch on Windows misses appends to a file held open elsewhere.
 */

export const SERVER_LOG_POLL_MS = 1_000;
/** Cap on one read, so a log that grew by megabytes while VS Code slept does not flood the channel. */
export const SERVER_LOG_MAX_READ_BYTES = 256 * 1024;

export interface LogSink {
  appendLine(line: string): void;
  dispose(): void;
}

export class ServerLogFollower {
  private offset: number | undefined;
  private partial = '';
  private polling = false;
  private waitingReported = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    readonly filePath: string,
    private readonly sink: LogSink,
  ) {}

  start(intervalMs = SERVER_LOG_POLL_MS): void {
    this.sink.appendLine(`[Forge] following ${this.filePath}`);
    void this.poll();
    this.timer = setInterval(() => void this.poll(), intervalMs);
  }

  /** One read of whatever was appended since the last poll. Public for tests. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      let size: number;
      try {
        size = (await fs.stat(this.filePath)).size;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        if (!this.waitingReported) {
          this.sink.appendLine(`[Forge] waiting for ${this.filePath} (not created yet)`);
          this.waitingReported = true;
        }
        // Whatever appears at this path from now on is new output (a server
        // starting up, or a deleted log recreated): read it from the start.
        this.offset = 0;
        this.partial = '';
        return;
      }
      this.waitingReported = false;
      // First sight of an existing file: start at its end, not 150 KB of history.
      if (this.offset === undefined) {
        this.offset = size;
        return;
      }
      if (size < this.offset) {
        this.sink.appendLine(
          '[Forge] log was truncated (server restarted?) - reading from the start',
        );
        this.offset = 0;
        this.partial = '';
      }
      if (size === this.offset) return;
      let start = this.offset;
      if (size - start > SERVER_LOG_MAX_READ_BYTES) {
        this.sink.appendLine(
          `[Forge] skipped ${size - start - SERVER_LOG_MAX_READ_BYTES} bytes of backlog`,
        );
        start = size - SERVER_LOG_MAX_READ_BYTES;
        this.partial = '';
      }
      const handle = await fs.open(this.filePath, 'r');
      try {
        const buffer = Buffer.alloc(size - start);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
        this.offset = start + bytesRead;
        this.emit(buffer.subarray(0, bytesRead).toString('utf8'));
      } finally {
        await handle.close();
      }
    } catch (err) {
      this.sink.appendLine(`[Forge] cannot read ${this.filePath}: ${(err as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  private emit(chunk: string): void {
    const lines = (this.partial + chunk).split('\n');
    // The last element is an unfinished line (no newline yet) - hold it back.
    this.partial = lines.pop() ?? '';
    for (const raw of lines) {
      // A bare \r is a progress bar redrawing itself; keep the final state.
      const line = raw.replace(/\r$/, '');
      const shown = line.slice(line.lastIndexOf('\r') + 1);
      if (shown.trim()) this.sink.appendLine(shown);
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.sink.dispose();
  }
}

/** Channel title: the model's display name, so the Output dropdown says what it is. */
function channelName(model: ModelConfig): string {
  return `Forge - ${model.display_name ?? model.name} log`;
}

/**
 * Keeps one follower per configured `server_log`. `apply` is called on activation
 * and on every config reload; unchanged paths keep their follower (and offset).
 */
export class ServerLogFollowers implements vscode.Disposable {
  private readonly followers = new Map<string, ServerLogFollower>();

  constructor(
    private readonly makeSink: (name: string) => LogSink = (name) =>
      vscode.window.createOutputChannel(name),
  ) {}

  apply(config: ForgeConfig): void {
    const wanted = new Map<string, ModelConfig>();
    for (const model of config.models) {
      if (model.server_log && !wanted.has(model.server_log)) wanted.set(model.server_log, model);
    }
    for (const [file, follower] of this.followers) {
      if (!wanted.has(file)) {
        follower.dispose();
        this.followers.delete(file);
      }
    }
    for (const [file, model] of wanted) {
      if (this.followers.has(file)) continue;
      const follower = new ServerLogFollower(file, this.makeSink(channelName(model)));
      this.followers.set(file, follower);
      follower.start();
    }
  }

  get paths(): string[] {
    return [...this.followers.keys()];
  }

  dispose(): void {
    for (const follower of this.followers.values()) follower.dispose();
    this.followers.clear();
  }
}
