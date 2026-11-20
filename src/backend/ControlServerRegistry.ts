import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeFileAtomicSync } from '../util/atomicWrite';

export interface ControlServerRecord {
  url: string;
  pid: number;
  startedAt: string;
  version: string;
  /** Bearer token every model route demands; regenerated on each server start,
   *  so a consumer must re-read this file after a Forge restart. */
  token: string;
}

export interface IControlServerRegistry {
  publish(record: ControlServerRecord): void;
  removeIfOwned(pid: number): void;
}

/** Where the discovery record lives. Windows: `%LOCALAPPDATA%\forge-llm\…`;
 *  anywhere LOCALAPPDATA is unset (macOS/Linux) `~/.forge/…`, so a consumer can
 *  read the token there too. `home` is injectable for tests. Treat an empty
 *  `localAppData` as unset: an explicit `undefined` re-applies the env default,
 *  so a non-Windows test must pass `''`, not `undefined`. Returns null only
 *  when neither LOCALAPPDATA nor a home directory is available. */
export function controlServerRegistryPath(
  localAppData = process.env.LOCALAPPDATA,
  home = os.homedir(),
): string | null {
  if (localAppData) return path.join(localAppData, 'forge-llm', 'control-server.json');
  return home ? path.join(home, '.forge', 'control-server.json') : null;
}

/** Atomic localhost control-server discovery record for external Forge clients. */
export class ControlServerRegistry implements IControlServerRegistry {
  constructor(private readonly filePath: string) {}

  publish(record: ControlServerRecord): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomicSync(this.filePath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
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
