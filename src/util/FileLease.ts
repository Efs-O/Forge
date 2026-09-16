import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { z } from 'zod';

/**
 * A cross-process single-owner lease backed by an exclusive-creation file.
 *
 * Moved out of `src/remote/RemoteTransportLease.ts` (which now re-exports it)
 * so the job scheduler can hold its own `jobs-scheduler` lease without
 * importing from the remote subsystem. The mechanism is identical: one file
 * per key, created with `wx` (exclusive), heartbeated, and reclaimed when the
 * owner's heartbeat goes stale.
 *
 * The lease is advisory and cooperative — it is not a guarantee against a
 * process that ignores it, but it is enough to stop two VS Code windows from
 * both running the scheduler for the same workspace.
 */

const LeaseSchema = z.object({
  version: z.literal(1),
  key: z.string(),
  token: z.string().uuid(),
  pid: z.number().int().positive(),
  processStartedAt: z.number().int().nonnegative(),
  instanceId: z.string(),
  workspaceId: z.string(),
  heartbeatAt: z.number().int().nonnegative(),
});
type LeaseRecord = z.infer<typeof LeaseSchema>;

export class FileLeaseError extends Error {}

export class FileLease {
  private timer: ReturnType<typeof setInterval> | undefined;
  private heartbeatTask: Promise<void> | undefined;
  private lost = false;

  private constructor(
    private readonly filePath: string,
    private readonly record: LeaseRecord,
    private readonly heartbeatMs: number,
    private readonly onLost: (message: string) => void,
  ) {}

  static async acquire(options: {
    directory: string;
    key: string;
    workspaceId: string;
    instanceId: string;
    heartbeatMs?: number;
    staleAfterMs?: number;
    onLost: (message: string) => void;
  }): Promise<FileLease> {
    const heartbeatMs = options.heartbeatMs ?? 5_000;
    const staleAfterMs = options.staleAfterMs ?? 20_000;
    await fs.mkdir(options.directory, { recursive: true });
    const safeKey = options.key.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = path.join(options.directory, `${safeKey}.lease.json`);
    const record: LeaseRecord = {
      version: 1,
      key: options.key,
      token: randomUUID(),
      pid: process.pid,
      processStartedAt: Math.max(0, Math.floor(Date.now() - process.uptime() * 1000)),
      instanceId: options.instanceId,
      workspaceId: options.workspaceId,
      heartbeatAt: Date.now(),
    };

    try {
      await FileLease.createExclusive(filePath, record);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // An unreadable lease is garbage, not a live owner: treat it as stale so a
      // corrupt file cannot wedge the holder with no recovery path.
      const existing = await FileLease.read(filePath).catch(() => undefined);
      if (existing && Date.now() - existing.heartbeatAt <= staleAfterMs) {
        throw new FileLeaseError(
          `Forge lease "${options.key}" is already owned by another window.`,
        );
      }
      const stalePath = `${filePath}.stale-${record.token}`;
      try {
        await fs.rename(filePath, stalePath);
        await FileLease.createExclusive(filePath, record);
        await fs.unlink(stalePath).catch(() => undefined);
      } catch (recoveryError) {
        throw new FileLeaseError(
          `Forge could not safely recover a stale lease: ${(recoveryError as Error).message}`,
        );
      }
    }
    const lease = new FileLease(filePath, record, heartbeatMs, options.onLost);
    lease.startHeartbeat();
    return lease;
  }

  isLost(): boolean {
    return this.lost;
  }

  async verify(): Promise<boolean> {
    try {
      const current = await FileLease.read(this.filePath);
      return current.token === this.record.token;
    } catch {
      return false;
    }
  }

  async release(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.heartbeatTask;
    if (!(await this.verify())) return;
    await fs.unlink(this.filePath).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }

  private startHeartbeat(): void {
    this.timer = setInterval(() => this.scheduleHeartbeat(), this.heartbeatMs);
  }

  private scheduleHeartbeat(): void {
    if (this.heartbeatTask || this.lost) return;
    const task = this.heartbeat();
    const tracked = task.finally(() => {
      if (this.heartbeatTask === tracked) this.heartbeatTask = undefined;
    });
    this.heartbeatTask = tracked;
  }

  private async heartbeat(): Promise<void> {
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(this.filePath, 'r+');
      const previous = Buffer.from(await handle.readFile('utf8'));
      const current = LeaseSchema.parse(JSON.parse(previous.toString('utf8')));
      if (current.token !== this.record.token) {
        this.lose('Forge lease was lost; this window has stopped holding it.');
        return;
      }
      this.record.heartbeatAt = Date.now();
      // Never truncate before writing: another heartbeat, verifier, or process
      // could observe the empty interval and mistake this live lease for stale
      // garbage. Write one complete buffer at offset zero. Padding preserves the
      // previous file length if a field ever becomes shorter; JSON permits the
      // trailing spaces. The normal heartbeat timestamp has fixed width.
      const serialized = Buffer.from(JSON.stringify(this.record), 'utf8');
      const next =
        serialized.length < previous.length
          ? Buffer.concat([serialized, Buffer.alloc(previous.length - serialized.length, 0x20)])
          : serialized;
      await handle.write(next, 0, next.length, 0);
    } catch (err) {
      this.lose(`Forge lease heartbeat failed: ${(err as Error).message}`);
    } finally {
      await handle?.close();
    }
  }

  private lose(message: string): void {
    if (this.lost) return;
    this.lost = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.onLost(message);
  }

  private static async createExclusive(filePath: string, record: LeaseRecord): Promise<void> {
    const handle = await fs.open(filePath, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(record), 'utf8');
    } finally {
      await handle.close();
    }
  }

  private static async read(filePath: string): Promise<LeaseRecord> {
    return LeaseSchema.parse(JSON.parse(await fs.readFile(filePath, 'utf8')));
  }
}
