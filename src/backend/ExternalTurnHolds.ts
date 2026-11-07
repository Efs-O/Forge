import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isProcessAlive } from '../util/processLiveness';
import { getLogger } from '../util/logger';
import { writeFileAtomicSync } from '../util/atomicWrite';

const log = getLogger();

export interface ExternalTurnHold {
  id: string;
  model: string;
  pid: number;
  conversationId: string;
  title: string;
  expiresAt: number;
}

export interface ExternalTurnLease {
  release(): void;
}

const EXTERNAL_HOLD_TTL_MS = 90_000;
const EXTERNAL_HOLD_REFRESH_MS = 15_000;

/**
 * Machine-wide turn holds over managed external servers: one JSON record per
 * live turn under `<root>/external-turn-holds`, refreshed on an interval and
 * reclaimed when the writing process dies.
 *
 * Split out of `SharedRuntimeRegistry` (2026-11-07). The registry keeps
 * forwarding to it so no consumer is rewired; the on-disk layout, the TTL, the
 * refresh interval and the lock path are unchanged by that move.
 */
export class ExternalTurnHolds {
  private readonly root: string;

  constructor(
    root = path.join(process.env.LOCALAPPDATA ?? '', 'forge-llm', 'shared-runtimes'),
    private readonly isAlive: (pid: number) => boolean = isProcessAlive,
    private readonly now: () => number = Date.now,
  ) {
    this.root = root;
  }

  /**
   * Hold a managed external server for a whole sidebar turn in machine-wide lease files.
   * Only a hold on a model that `shares` a card refuses it, as `prepareExternalForRequest`
   * does. Live turns refresh the TTL; dead hosts and expired turns are reclaimed.
   */
  async acquireExternalTurnHold(
    model: string,
    conversationId: string,
    title: string,
    shares: (otherModel: string) => boolean,
  ): Promise<ExternalTurnLease> {
    const id = `${process.pid}-${crypto.randomUUID()}`;
    const file = this.externalHoldPath(id);
    await this.withExternalTurnHoldLock(async () => {
      const conflict = this.externalTurnHolders().find((h) => h.model !== model && shares(h.model));
      if (conflict) throw externalHoldConflict(conflict, model);
      this.writeExternalHold(file, {
        id,
        model,
        pid: process.pid,
        conversationId,
        title,
        expiresAt: this.now() + EXTERNAL_HOLD_TTL_MS,
      });
    });
    return this.holdLease(id, file);
  }

  /**
   * Take a hold while the caller ALREADY holds the machine-wide lock, so its
   * conflict check, its GPU frees and this claim are one critical section
   * instead of two: otherwise another window can slip between the frees and the
   * claim and take the GPUs just freed for us. `acquireExternalTurnHold` cannot
   * be used inside that lock — it waits on the same non-reentrant `mkdir` lock
   * (BL-020). No conflict check here: the caller has just done it under the lock.
   */
  claimExternalTurnHold(model: string, conversationId: string, title: string): ExternalTurnLease {
    const id = `${process.pid}-${crypto.randomUUID()}`;
    const file = this.externalHoldPath(id);
    this.writeExternalHold(file, {
      id,
      model,
      pid: process.pid,
      conversationId,
      title,
      expiresAt: this.now() + EXTERNAL_HOLD_TTL_MS,
    });
    return this.holdLease(id, file);
  }

  /** The refresh interval and the idempotent release for a hold already written. */
  private holdLease(id: string, file: string): ExternalTurnLease {
    let released = false;
    const refresh = setInterval(() => {
      if (released) return;
      try {
        const current = this.readExternalHold(file);
        if (current?.pid === process.pid && current.id === id) {
          this.writeExternalHold(file, {
            ...current,
            expiresAt: this.now() + EXTERNAL_HOLD_TTL_MS,
          });
        }
      } catch (error) {
        log.warn(
          `[SharedRuntimeRegistry] could not refresh external turn hold ${id}: ${String(error)}`,
        );
      }
    }, EXTERNAL_HOLD_REFRESH_MS);
    refresh.unref?.();
    return {
      release: () => {
        if (released) return;
        released = true;
        clearInterval(refresh);
        fs.rmSync(file, { force: true });
      },
    };
  }

  /** Live managed-external turn holds, with records whose process died collected. */
  externalTurnHolders(): ExternalTurnHold[] {
    const dir = this.externalHoldDir();
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
    } catch {
      return [];
    }
    const holds: ExternalTurnHold[] = [];
    for (const name of files) {
      const file = path.join(dir, name);
      const hold = this.readExternalHold(file);
      if (hold && this.isAlive(hold.pid)) {
        holds.push(hold);
        continue;
      }
      // A record whose process died is gone, expired or not. An expired record
      // whose process is ALIVE is kept (BL-021): the refresh is a `setInterval`,
      // which cannot fire while the machine is suspended, so a sleep longer than
      // the TTL makes a good turn look abandoned, and reclaiming it there lets
      // another window unload the model the resumed turn is about to ask for —
      // the failure the hold exists to prevent. The cost is bounded: a window
      // that leaks a hold keeps it until that window closes, and every turn path
      // releases in its `finally`.
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // A concurrent window reclaimed it first.
      }
    }
    return holds;
  }

  async withExternalTurnHoldLock<T>(fn: () => Promise<T>): Promise<T> {
    const lock = path.join(this.externalHoldDir(), '.lock');
    const ownerFile = path.join(lock, 'owner.json');
    fs.mkdirSync(this.externalHoldDir(), { recursive: true });
    const deadline = this.now() + 5_000;
    const ownerId = crypto.randomUUID();
    for (;;) {
      try {
        fs.mkdirSync(lock);
        writeFileAtomicSync(ownerFile, `${JSON.stringify({ pid: process.pid, ownerId })}\n`);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')) as {
            pid?: number;
            ownerId?: string;
          };
          if (typeof owner.pid === 'number' && !this.isAlive(owner.pid)) {
            fs.rmSync(lock, { recursive: true, force: true });
          } else if (this.now() - fs.statSync(lock).mtimeMs > 10_000) {
            // A crashed writer may die between mkdir and writing owner.json.
            if (owner.pid === undefined) fs.rmSync(lock, { recursive: true, force: true });
          }
        } catch {
          // A partially-created lock is reclaimed after the stale threshold.
          try {
            if (this.now() - fs.statSync(lock).mtimeMs > 10_000)
              fs.rmSync(lock, { recursive: true, force: true });
          } catch {
            // Another window removed it first.
          }
        }
        if (this.now() >= deadline)
          throw new Error(
            'Timed out waiting for managed-server turn holds: another window is holding them ' +
              'while it checks or frees a managed model. Send again in a few seconds.',
          );
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    try {
      return await fn();
    } finally {
      try {
        const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')) as { ownerId?: string };
        if (owner.ownerId === ownerId) fs.rmSync(lock, { recursive: true, force: true });
      } catch {
        // The lock may already have been reclaimed after a host interruption.
      }
    }
  }

  private externalHoldDir(): string {
    return path.join(this.root, 'external-turn-holds');
  }

  private externalHoldPath(id: string): string {
    return path.join(this.externalHoldDir(), `${id}.json`);
  }

  private readExternalHold(file: string): ExternalTurnHold | undefined {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8')) as ExternalTurnHold;
      return typeof value.id === 'string' &&
        typeof value.model === 'string' &&
        typeof value.pid === 'number' &&
        typeof value.expiresAt === 'number' &&
        typeof value.conversationId === 'string' &&
        typeof value.title === 'string'
        ? value
        : undefined;
    } catch {
      return undefined;
    }
  }

  private writeExternalHold(file: string, hold: ExternalTurnHold): void {
    writeFileAtomicSync(file, `${JSON.stringify(hold)}\n`);
  }
}

/**
 * Why a model cannot be taken: the advice differs by what the waiting window is
 * trying to do, and the wrong tail sends the agent hunting for a slot that does
 * not exist. `swap` is a request for another managed model, `local-load` is a
 * GGUF or Ollama model that needs the same GPUs, and `release` is an unload
 * this window asked for while another window is still serving the model.
 */
export function externalHoldConflict(
  hold: ExternalTurnHold,
  requestedModel: string,
  cause: 'swap' | 'local-load' | 'release' = 'swap',
): Error {
  if (cause === 'local-load') {
    return new Error(
      `Loading ${requestedModel} needs the GPUs ${hold.model} is using for chat ` +
        `'${hold.title}'. Wait for that turn to end, or switch this chat to ${hold.model}.`,
    );
  }
  if (cause === 'release') {
    return new Error(
      `Unloading ${hold.model} would cut off chat '${hold.title}' in another window. ` +
        `Wait for that turn to end, or unload from the window that is serving it.`,
    );
  }
  return new Error(
    `${hold.model} is serving chat '${hold.title}' right now. Loading ${requestedModel} would cut that turn off. ` +
      `Use ${hold.model} here (it may have a free slot), or wait for that turn to end.`,
  );
}
