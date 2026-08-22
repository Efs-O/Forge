import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isProcessAlive } from '../util/processLiveness';
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

export function sharedRuntimeKey(model: {
  name: string;
  gguf_path?: string;
  spawn?: unknown;
}): string {
  const identity = JSON.stringify(model);
  return crypto.createHash('sha256').update(identity).digest('hex');
}
