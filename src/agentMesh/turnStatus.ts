import * as fs from 'fs';
import * as path from 'path';
import { getHostIdentity, isHostAlive } from './hostIdentity';

/**
 * The F-08 bus-turn status file. While a bus-started turn runs, a status file
 * (`status/<turnId>.json`) records that it is in flight and who owns it; it is
 * deleted when the turn finishes. The normal in-process finished notice lives
 * in the messaging wiring; this is the durable half — a status file left by a
 * CRASHED turn can be detected and swept at the next window's startup.
 *
 * The record names the owning host (`{pid, startedAt}`) so a sweep only clears
 * files whose owner is proven dead: a second extension window may have a live
 * turn in the shared bus directory, and clearing it would hide a running turn.
 */
export interface TurnStatusRecord {
  turnId: string;
  host_pid: number;
  host_started_at: number;
  started_at: number;
  last_activity_at: number;
  tool_calls: number;
  state: 'running';
  plan: { done: number; total: number; current: string };
  context_pct: number | null;
  detail: string;
}

export class TurnStatus {
  constructor(private readonly dir: string) {}

  /** Mark a bus turn in flight (writes `status/<turnId>.json`). */
  markTurnStarted(turnId: string, detail: string): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const host = getHostIdentity();
      const now = Date.now();
      const record: TurnStatusRecord = {
        turnId,
        host_pid: host.pid,
        host_started_at: host.startedAt,
        started_at: now,
        last_activity_at: now,
        tool_calls: 0,
        state: 'running',
        plan: { done: 0, total: 0, current: '' },
        context_pct: null,
        detail,
      };
      fs.writeFileSync(
        path.join(this.dir, `${turnId}.json`),
        `${JSON.stringify(record, null, 2)}\n`,
        'utf8',
      );
    } catch {
      // Best-effort; a status-file failure must not block a turn.
    }
  }

  /** Mark a bus turn finished (deletes `status/<turnId>.json`). */
  markTurnFinished(turnId: string): void {
    try {
      fs.unlinkSync(path.join(this.dir, `${turnId}.json`));
    } catch {
      // Absent: nothing to clear.
    }
  }

  /**
   * Clear status files whose owning host is proven dead. A file whose owner is
   * still alive (or unprovable) is left: another window may be running a turn.
   * Returns the number of files removed.
   */
  sweepDead(): number {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return 0; // no status dir yet
    }
    let removed = 0;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.dir, name);
      let record: TurnStatusRecord | undefined;
      try {
        record = JSON.parse(fs.readFileSync(file, 'utf8')) as TurnStatusRecord;
      } catch {
        continue; // corrupt: leave it
      }
      if (
        record &&
        typeof record.host_pid === 'number' &&
        typeof record.host_started_at === 'number' &&
        !isHostAlive({ pid: record.host_pid, startedAt: record.host_started_at })
      ) {
        try {
          fs.unlinkSync(file);
          removed += 1;
        } catch {
          // Absent: another window cleared it.
        }
      }
    }
    return removed;
  }
}
