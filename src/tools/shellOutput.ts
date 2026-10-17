import { createWriteStream, mkdirSync, type WriteStream } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Readable } from 'stream';
import { finished } from 'stream/promises';

export const SHELL_OUTPUT_CAP = 30_000;
export const SHELL_OUTPUT_HEAD = 10_000;
export const SHELL_OUTPUT_TAIL = 20_000;
export const SHELL_OUTPUT_TTL_MS = 24 * 60 * 60 * 1000;

export interface CappedShellOutput {
  text: string;
  spillPath?: string;
  spillError?: string;
}

export function shellOutputRoot(home = os.homedir()): string {
  return path.join(home, '.forge', 'shell-output');
}

/**
 * Collects a command's output as it arrives. Within the cap it is kept whole;
 * past it only the head and a rolling tail stay in memory and the complete
 * output streams to the spill file, so a chatty command (`yes`, a verbose
 * build) cannot grow memory for its whole timeout.
 */
export class ShellOutputCollector {
  private head = '';
  private tail = '';
  private total = 0;
  private overflowed = false;
  private finished = false;
  private spill: WriteStream | undefined;
  private spillError: string | undefined;
  private readonly headCap: number;
  private readonly tailCap: number;
  private readonly spillPath: string;

  constructor(
    conversationId: string,
    toolCallId: string,
    private readonly cap = SHELL_OUTPUT_CAP,
    root = shellOutputRoot(),
  ) {
    this.headCap = Math.floor(cap / 3);
    this.tailCap = cap - this.headCap;
    const safeConversation = conversationId.replace(/[^a-zA-Z0-9_-]/gu, '_');
    const safeCall = toolCallId.replace(/[^a-zA-Z0-9_-]/gu, '_');
    this.spillPath = path.join(root, safeConversation, `${safeCall}.log`);
  }

  /** Reads a pipe into the collector; a backed-up spill file pauses the pipe. */
  collect(stream: Readable): void {
    stream.setEncoding('utf8').on('data', (chunk: string) => {
      if (this.append(chunk)) return;
      stream.pause();
      void this.drained().then(() => stream.resume());
    });
  }

  /** False while the spill file is backed up: hold further output until `drained()`. */
  append(chunk: string): boolean {
    // A killed command's pipes can still deliver after the result is built.
    if (this.finished) return true;
    this.total += chunk.length;
    if (!this.overflowed) {
      this.head += chunk;
      if (this.total <= this.cap) return true;
      this.overflowed = true;
      const everything = this.head;
      this.head = everything.slice(0, this.headCap);
      this.tail = everything.slice(-this.tailCap);
      this.openSpill();
      return this.write(everything);
    }
    this.tail += chunk;
    if (this.tail.length > 2 * this.tailCap) this.tail = this.tail.slice(-this.tailCap);
    return this.write(chunk);
  }

  drained(): Promise<void> {
    const spill = this.spill;
    if (!spill || this.spillError !== undefined || !spill.writableNeedDrain)
      return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        spill.off('drain', done).off('close', done);
        resolve();
      };
      spill.once('drain', done).once('close', done);
    });
  }

  async finish(): Promise<CappedShellOutput> {
    this.finished = true;
    if (!this.overflowed) return { text: this.head };
    const spill = this.spill;
    if (spill && this.spillError === undefined) {
      spill.end();
      await finished(spill).catch((error: unknown) => this.fail(error));
    }
    const tail = this.tail.slice(-this.tailCap);
    const omitted = this.total - this.head.length - tail.length;
    const hint =
      this.spillError !== undefined
        ? `full output could not be saved: ${this.spillError}`
        : `Full output: ${this.spillPath} — search it with the shell (Select-String / rg / tail) instead of rerunning the command`;
    return {
      text: `${this.head}\n[… ${omitted} characters omitted. ${hint}]\n${tail}`,
      ...(this.spillError !== undefined
        ? { spillError: this.spillError }
        : { spillPath: this.spillPath }),
    };
  }

  private openSpill(): void {
    try {
      mkdirSync(path.dirname(this.spillPath), { recursive: true });
      this.spill = createWriteStream(this.spillPath, { encoding: 'utf8' });
      this.spill.on('error', (error) => this.fail(error));
    } catch (error) {
      this.fail(error);
    }
  }

  private write(data: string): boolean {
    if (!this.spill || this.spillError !== undefined) return true;
    return this.spill.write(data);
  }

  private fail(error: unknown): void {
    this.spillError ??= error instanceof Error ? error.message : String(error);
    this.spill?.destroy();
  }
}

export async function capShellOutput(
  output: string,
  conversationId: string,
  toolCallId: string,
  cap = SHELL_OUTPUT_CAP,
  root = shellOutputRoot(),
): Promise<CappedShellOutput> {
  const collector = new ShellOutputCollector(conversationId, toolCallId, cap, root);
  collector.append(output);
  return collector.finish();
}

export async function sweepShellOutput(root = shellOutputRoot(), now = Date.now()): Promise<void> {
  const sweepDir = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await sweepDir(target);
      else if (entry.isFile()) {
        const stat = await fs.stat(target);
        if (now - stat.mtimeMs > SHELL_OUTPUT_TTL_MS) await fs.unlink(target);
      }
    }
    try {
      if ((await fs.readdir(directory)).length === 0) await fs.rmdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
  await sweepDir(root);
}
