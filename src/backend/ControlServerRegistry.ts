import * as fs from 'fs';
import * as path from 'path';

export interface ControlServerRecord {
  url: string;
  pid: number;
  startedAt: string;
  version: string;
}

export interface IControlServerRegistry {
  publish(record: ControlServerRecord): void;
  removeIfOwned(pid: number): void;
}

export function controlServerRegistryPath(localAppData = process.env.LOCALAPPDATA): string | null {
  return localAppData ? path.join(localAppData, 'forge-llm', 'control-server.json') : null;
}

/** Atomic localhost control-server discovery record for external Forge clients. */
export class ControlServerRegistry implements IControlServerRegistry {
  constructor(private readonly filePath: string) {}

  publish(record: ControlServerRecord): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      fs.renameSync(temporary, this.filePath);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  removeIfOwned(pid: number): void {
    let record: unknown;
    try {
      record = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as unknown;
    } catch {
      return;
    }
    if (!isRecordOwnedBy(record, pid)) return;
    fs.rmSync(this.filePath, { force: true });
  }
}

function isRecordOwnedBy(value: unknown, pid: number): boolean {
  if (!value || typeof value !== 'object') return false;
  return (value as { pid?: unknown }).pid === pid;
}
