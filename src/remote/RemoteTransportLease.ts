import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { z } from 'zod';

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

export class RemoteLeaseError extends Error {}

export class RemoteTransportLease {
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
  }): Promise<RemoteTransportLease> {
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
      await RemoteTransportLease.createExclusive(filePath, record);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // An unreadable lease is garbage, not a live owner: treat it as stale so a
      // corrupt file cannot wedge remote control with no recovery path.
      const existing = await RemoteTransportLease.read(filePath).catch(() => undefined);
      if (existing && Date.now() - existing.heartbeatAt <= staleAfterMs) {
        throw new RemoteLeaseError('Forge remote transport is already owned by another window.');
      }
      const stalePath = `${filePath}.stale-${record.token}`;
      try {
        await fs.rename(filePath, stalePath);
        await RemoteTransportLease.createExclusive(filePath, record);
        await fs.unlink(stalePath).catch(() => undefined);
      } catch (recoveryError) {
        throw new RemoteLeaseError(
          `Forge could not safely recover a stale remote lease: ${(recoveryError as Error).message}`,
        );
      }
    }
    const lease = new RemoteTransportLease(filePath, record, heartbeatMs, options.onLost);
    lease.startHeartbeat();
    return lease;
  }

  isLost(): boolean {
    return this.lost;
  }

  async verify(): Promise<boolean> {
    try {
      const current = await RemoteTransportLease.read(this.filePath);
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
        this.lose('Forge remote transport lease was lost; inbound control has stopped.');
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
      this.lose(`Forge remote lease heartbeat failed: ${(err as Error).message}`);
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
