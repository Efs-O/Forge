import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isProcessAlive } from '../util/processLiveness';
import { composeLlamaServerArgs } from './LlamaServerArgs';
import type { LlamaServerConfig, ModelConfig } from '../config/types';
import { getLogger } from '../util/logger';
import { writeFileAtomicSync } from '../util/atomicWrite';
import {
  ExternalTurnHolds,
  type ExternalTurnHold,
  type ExternalTurnLease,
} from './ExternalTurnHolds';

const log = getLogger();

interface LeaseRecord {
  pid: number;
  createdAt?: string;
}

export interface SharedRuntimeRecord {
  key: string;
  model: string;
  endpoint: string;
  ownerPid: number;
  createdAt: string;
  /** False while the owning window is checking whether it can safely stop. */
  acceptingBorrowers?: boolean;
}

export type { ExternalTurnHold, ExternalTurnLease } from './ExternalTurnHolds';
export { externalHoldConflict } from './ExternalTurnHolds';

/** Local, machine-wide discovery plus per-client lease files for llama.cpp. */
export class SharedRuntimeRegistry {
  private readonly root: string;
  private readonly holds: ExternalTurnHolds;

  constructor(
    root = path.join(process.env.LOCALAPPDATA ?? '', 'forge-llm', 'shared-runtimes'),
    private readonly isAlive: (pid: number) => boolean = isProcessAlive,
    private readonly now: () => number = Date.now,
  ) {
    this.root = root;
    this.holds = new ExternalTurnHolds(root, this.isAlive, this.now);
  }

  find(key: string): SharedRuntimeRecord | undefined {
    const value = this.readOwner(key);
    return value?.acceptingBorrowers === false ? undefined : value;
  }

  /** Atomically drain new borrowers before an owner checks existing leases. */
  beginDraining(key: string): boolean {
    const record = this.readOwner(key);
    if (!record || record.ownerPid !== process.pid) return false;
    this.writeOwner({ ...record, acceptingBorrowers: false });
    return true;
  }

  resumeBorrowing(key: string): void {
    const record = this.readOwner(key);
    if (record?.ownerPid === process.pid) this.writeOwner({ ...record, acceptingBorrowers: true });
  }

  /** Records a lease only if the same owner is still accepting borrowers. */
  acquireLeaseIfActive(key: string, id: string, expected: SharedRuntimeRecord): boolean {
    this.acquireLease(key, id);
    const current = this.find(key);
    const valid =
      current?.ownerPid === expected.ownerPid &&
      current.endpoint === expected.endpoint &&
      current.createdAt === expected.createdAt;
    if (!valid) this.releaseLease(key, id);
    return valid;
  }

  private readOwner(key: string): SharedRuntimeRecord | undefined {
    try {
      const value = JSON.parse(fs.readFileSync(this.ownerPath(key), 'utf8')) as SharedRuntimeRecord;
      return value.key === key && typeof value.endpoint === 'string' ? value : undefined;
    } catch {
      return undefined;
    }
  }

  publish(record: SharedRuntimeRecord): void {
    fs.mkdirSync(this.root, { recursive: true });
    this.writeOwner({ ...record, acceptingBorrowers: true });
  }

  removeOwner(key: string): void {
    const record = this.readOwner(key);
    if (record?.ownerPid !== process.pid) return;
    fs.rmSync(this.ownerPath(key), { force: true });
    // BL-022: the key is a hash of the spawn argv, so a change to `n_ctx`,
    // `n_parallel`, `--threads`, the GGUF path or the llama.cpp build makes a
    // new identity, and nothing else ever deletes the old one's folder — one
    // empty directory per runtime identity this machine has ever published.
    // `rmdirSync` is the safe form: it fails ENOTEMPTY when a borrower wrote a
    // lease in between, so a live lease can never be thrown away, and a stale
    // writer's temp file keeps the folder rather than losing the record.
    try {
      fs.rmdirSync(this.leaseDir(key));
    } catch (error) {
      // Already gone or never created (ENOENT), a lease arrived in the
      // meantime (ENOTEMPTY), or a process holds a handle inside it — Windows
      // answers EBUSY or EPERM. Each is the right outcome, so it is not
      // reported; anything else is a surprise and gets logged rather than
      // swallowed.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM') return;
      log.debug(
        `[SharedRuntimeRegistry] could not remove the lease folder for ${key}: ${String(error)}`,
      );
    }
  }

  acquireLease(key: string, id: string): void {
    const dir = this.leaseDir(key);
    fs.mkdirSync(dir, { recursive: true });
    const lease: LeaseRecord = { pid: process.pid, createdAt: new Date().toISOString() };
    const target = path.join(dir, `${id}.json`);
    const record = `${JSON.stringify(lease)}\n`;
    try {
      writeFileAtomicSync(target, record);
    } catch (error) {
      // The owner can delete this very folder between our mkdir and the write —
      // `removeOwner` removes it once it is empty (BL-022) — and then the write
      // lands on a folder that is gone. Recreate it and write once more: the
      // record is then judged by `acquireLeaseIfActive`'s owner check like any
      // other, so the borrowing window gets the honest "not active, start your
      // own" answer instead of an ENOENT from inside its acquire path.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      fs.mkdirSync(dir, { recursive: true });
      writeFileAtomicSync(target, record);
    }
  }

  releaseLease(key: string, id: string): void {
    fs.rmSync(path.join(this.leaseDir(key), `${id}.json`), { force: true });
  }

  /**
   * True when at least one LIVE borrower holds a lease, reclaiming any lease
   * whose owner died without releasing it (crash, force-kill, OS restart).
   *
   * This is a garbage collector as well as a predicate, so every step is
   * individually best-effort: a lease can vanish between readdir and read, and
   * another window may be reclaiming the same directory concurrently. Nothing
   * here may throw — a scan failure must not make an owner refuse to unload.
   */
  hasBorrowers(key: string): boolean {
    const dir = this.leaseDir(key);
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
    } catch {
      return false;
    }

    let live = false;
    for (const name of names) {
      const file = path.join(dir, name);
      const lease = this.readLease(file);
      if (lease && this.isAlive(lease.pid)) {
        live = true;
        continue;
      }
      try {
        fs.rmSync(file, { force: true });
        log.debug(
          `[SharedRuntimeRegistry] reclaimed stale runtime lease ${name} ` +
            `pid=${lease?.pid ?? 'unreadable'}`,
        );
      } catch {
        // Another window reclaimed it first, or the file vanished mid-scan.
      }
    }
    return live;
  }

  /** A well-formed lease, or undefined when unreadable/malformed/vanished. */
  private readLease(file: string): LeaseRecord | undefined {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8')) as LeaseRecord;
      return typeof value?.pid === 'number' ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private ownerPath(key: string): string {
    return path.join(this.root, `${key}.json`);
  }

  private writeOwner(record: SharedRuntimeRecord): void {
    fs.mkdirSync(this.root, { recursive: true });
    writeFileAtomicSync(this.ownerPath(record.key), `${JSON.stringify(record)}\n`);
  }
  /** Where `key`'s lease files live; the deferred stop watcher reads it after the host exits. */
  leaseDir(key: string): string {
    return path.join(this.root, `${key}.leases`);
  }

  /**
   * Managed-external turn holds live in `ExternalTurnHolds` (moved out
   * 2026-11-07). These forward to it so no consumer is rewired; the on-disk
   * layout, TTL, refresh interval and lock path are unchanged.
   */
  async acquireExternalTurnHold(
    model: string,
    conversationId: string,
    title: string,
    shares: (otherModel: string) => boolean,
  ): Promise<ExternalTurnLease> {
    return this.holds.acquireExternalTurnHold(model, conversationId, title, shares);
  }

  claimExternalTurnHold(model: string, conversationId: string, title: string): ExternalTurnLease {
    return this.holds.claimExternalTurnHold(model, conversationId, title);
  }

  externalTurnHolders(): ExternalTurnHold[] {
    return this.holds.externalTurnHolders();
  }

  withExternalTurnHoldLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.holds.withExternalTurnHoldLock(fn);
  }
}

/**
 * Canonical form of a path for identity comparison. Case-folding is correct on
 * Windows and WRONG elsewhere: on a case-sensitive filesystem /models/Qwen.gguf
 * and /models/qwen.gguf are different files and must not collide into one
 * runtime identity.
 */
function canonicalRuntimePath(value: string): string {
  let resolved = value;
  try {
    resolved = fs.realpathSync(value);
  } catch {
    // Not on disk (yet) — fall back to lexical normalization.
  }
  // Separators are folded BEFORE normalizing, and normalized with the posix
  // rules on every platform. Order matters: `path.normalize` on Linux/macOS
  // does not treat `\` as a separator, so normalizing first would leave the
  // `..` in a Windows-style path uncollapsed and produce a different key for
  // the same model depending on which OS read the config.
  const normalized = path.posix.normalize(resolved.replace(/\\/g, '/'));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** argv flags that identify THIS server instance rather than its semantics. */
const INSTANCE_ARGS = new Set(['--host', '--port']);
/** argv flags whose value is a path and must be canonicalized before hashing. */
const PATH_ARGS = new Set(['-m', '--mmproj']);

/**
 * Identity of the llama-server a model would spawn — two windows may share a
 * runtime only when these match.
 *
 * Derived from `composeLlamaServerArgs` rather than a hand-listed set of
 * fields, so anything that changes the spawned argv changes the identity
 * automatically. A parallel field list would silently drift: `--threads` and
 * `--threads-batch` were already missing from one.
 *
 * Argument ORDER is preserved, never sorted: llama.cpp honours later-option
 * precedence, so a repeated flag is not order-independent, and
 * `extra_llama_server_args` is passed through verbatim.
 */
export function sharedRuntimeKey(model: ModelConfig, server: LlamaServerConfig): string {
  const argv = composeLlamaServerArgs('', model, server, 'identity', 0);
  // The binary is not in argv, but two builds are two servers: the same
  // choice DirectBackend.startLlamaServer makes.
  const binary = model.llama_server_binary ?? server.binary;
  const identity: string[] = ['binary', binary ? canonicalRuntimePath(binary) : ''];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (INSTANCE_ARGS.has(arg)) {
      i++; // skip its value too
      continue;
    }
    if (PATH_ARGS.has(arg) && argv[i + 1] !== undefined) {
      identity.push(arg, canonicalRuntimePath(argv[++i]!));
      continue;
    }
    identity.push(arg);
  }
  // Joined on NUL so no argument value can forge a boundary; arrays keep
  // their order, so there is no property-order hazard here.
  return crypto.createHash('sha256').update(identity.join('\u0000')).digest('hex');
}
