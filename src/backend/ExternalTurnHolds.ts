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
  /** True while this window knows it made a residency change that no reader can
   *  see in the token. Its own answer then becomes "cannot prove", so nothing in
   *  this window may trust a residency map until a publication succeeds again —
   *  and any later success publishes a token no earlier read can match anyway. */
  private residencyPublicationBroken = false;

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
        // Publish BEFORE the record goes, never after: a scan that runs once the
        // record is gone must be able to see the newer token, while one that ran
        // before it still saw the hold (BL-032, Codex's fourth round — removing
        // first lets a reader scan in the gap and trust a map that is already
        // stale, and a crash in that gap leaves nothing to reclaim). If the
        // publication cannot be made at all the record stays: a hold another
        // window can see is a refusal, which is the safe side of a filesystem it
        // cannot write. The TTL cannot help here — BL-021 keeps an expired record
        // whose process lives, so this one lasts until this window exits.
        if (!this.bumpExternalResidencyGeneration()) return;
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
      // A dead host's turn ends with no release publication, so this reclaim is the
      // only thing that can tell the other windows the model is now resident and
      // unheld (BL-032). Publishing before the removal is what makes the scanning
      // window distrust a residency map it read earlier, and a record whose
      // publication failed is left standing for the next scan to try again — a dead
      // record never blocks a load, while a token that silently never changed would
      // let every reader trust the map it cannot prove.
      if (!this.bumpExternalResidencyGeneration()) continue;
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // A concurrent window reclaimed it first, and published for it.
      }
    }
    return holds;
  }

  /**
   * The machine-wide residency-change token (BL-032).
   *
   * A window that is about to free GPUs re-reads the managed endpoints' residency
   * BEFORE taking `withExternalTurnHoldLock`, because that re-read is a network
   * wait of up to ~4 s and the lock is the one thing another window's first
   * managed turn waits 5 s on. A probe outside the lock cannot answer the
   * question the frees need: did the board change while it was in flight? Every
   * window that loads a managed server, unloads one, or releases a turn hold
   * publishes a new token here, so the probing window compares the token it read
   * before the probe with the token it reads inside the lock — after its holder
   * scan — and frees conservatively when they differ.
   *
   * The token is a value, not a counter: a counter written by two windows at once
   * can lose an update, and a lost update would be a missed change, while two
   * tokens are never equal, so a lost write can only cost one extra unload.
   *
   * `''` means no trustworthy token exists — nothing published yet, or a publisher
   * that could not write. It is never equal to a published token, and a reader
   * must treat it as "cannot prove", never as "nothing changed".
   */
  externalResidencyGeneration(): string {
    if (this.residencyPublicationBroken) {
      // A change happened here that the token never recorded. Answering with the
      // token a reader might already hold would let it trust a map that is stale.
      return '';
    }
    try {
      return fs.readFileSync(this.residencyGenerationPath(), 'utf8');
    } catch {
      // Nothing to read: "cannot prove", which differs from every published
      // token, so a window that looked before the file existed still sees the
      // first change — and never mistakes an absent file for no change.
      return '';
    }
  }

  /** Publish that THIS window changed a managed server's residency, or that it
   *  cannot be trusted to know. A failed write removes the file rather than
   *  leaving the old token standing: a reader that had that token now reads `''`
   *  and takes the conservative path, so a lost publication cannot hide a change.
   *  Returns false only when NEITHER could be done — the old token is still
   *  readable and a reader would trust it — so the caller must keep whatever
   *  protection the record it was removing provides. */
  bumpExternalResidencyGeneration(): boolean {
    try {
      fs.mkdirSync(this.externalHoldDir(), { recursive: true });
      writeFileAtomicSync(
        this.residencyGenerationPath(),
        `${process.pid} ${this.now()} ${crypto.randomUUID()}\n`,
      );
      this.residencyPublicationBroken = false;
      return true;
    } catch (error) {
      try {
        fs.rmSync(this.residencyGenerationPath(), { force: true });
        // An absent file is itself "cannot prove", so this window is honest again.
        this.residencyPublicationBroken = false;
        log.warn(`[SharedRuntimeRegistry] residency change published as unknown: ${String(error)}`);
        return true;
      } catch {
        // Neither the token nor its removal could be written: the old token is
        // still readable and would be trusted, so this window's own answer becomes
        // unknown and the caller keeps whatever record it was about to remove.
        this.residencyPublicationBroken = true;
        log.error(
          `[SharedRuntimeRegistry] could not publish a residency change at all: ${String(error)} — ` +
            `a window that read the old token may still trust its residency map`,
        );
        return false;
      }
    }
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

  /** Not a `.json` hold record, so `externalTurnHolders` never reads it back as
   *  one, and not the `.lock` directory the reclaim logic stats. */
  private residencyGenerationPath(): string {
    return path.join(this.externalHoldDir(), '.residency-generation');
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
