import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

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

  constructor(root = path.join(process.env.LOCALAPPDATA ?? '', 'forge-llm', 'shared-runtimes')) {
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
    fs.writeFileSync(
      path.join(dir, `${id}.json`),
      `${JSON.stringify({ pid: process.pid })}\n`,
      'utf8',
    );
  }

  releaseLease(key: string, id: string): void {
    fs.rmSync(path.join(this.leaseDir(key), `${id}.json`), { force: true });
  }

  hasBorrowers(key: string): boolean {
    try {
      return fs.readdirSync(this.leaseDir(key)).some((name) => name.endsWith('.json'));
    } catch {
      return false;
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
