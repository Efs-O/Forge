import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isProcessAlive } from '../util/processLiveness';
import { composeLlamaServerArgs } from './LlamaServerArgs';
import type { LlamaServerConfig, ModelConfig } from '../config/types';
import { getLogger } from '../util/logger';

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
}

/** Local, machine-wide discovery plus per-client lease files for llama.cpp. */
export class SharedRuntimeRegistry {
  private readonly root: string;

  constructor(
    root = path.join(process.env.LOCALAPPDATA ?? '', 'forge-llm', 'shared-runtimes'),
    private readonly isAlive: (pid: number) => boolean = isProcessAlive,
  ) {
    this.root = root;
  }

  find(key: string): SharedRuntimeRecord | undefined {
    try {
      const value = JSON.parse(fs.readFileSync(this.ownerPath(key), 'utf8')) as SharedRuntimeRecord;
      return value.key === key && typeof value.endpoint === 'string' ? value : undefined;
    } catch {
      return undefined;
    }
  }

  publish(record: SharedRuntimeRecord): void {
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(this.ownerPath(record.key), `${JSON.stringify(record)}\n`, 'utf8');
  }

  removeOwner(key: string): void {
    const record = this.find(key);
    if (record?.ownerPid === process.pid) fs.rmSync(this.ownerPath(key), { force: true });
  }

  acquireLease(key: string, id: string): void {
    const dir = this.leaseDir(key);
    fs.mkdirSync(dir, { recursive: true });
    const lease: LeaseRecord = { pid: process.pid, createdAt: new Date().toISOString() };
    fs.writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify(lease)}\n`, 'utf8');
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
  private leaseDir(key: string): string {
    return path.join(this.root, `${key}.leases`);
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
  const identity: string[] = [];
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
