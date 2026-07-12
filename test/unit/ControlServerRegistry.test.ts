import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ControlServerRegistry,
  controlServerRegistryPath,
  type ControlServerRecord,
} from '../../src/backend/ControlServerRegistry';

const tempDirs: string[] = [];

function temporaryRegistry(): { registry: ControlServerRegistry; filePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-registry-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'forge-llm', 'control-server.json');
  return { registry: new ControlServerRegistry(filePath), filePath };
}

const record = (pid: number): ControlServerRecord => ({
  url: 'http://127.0.0.1:8799',
  pid,
  startedAt: '2026-07-11T18:00:00.000Z',
  version: '0.12.27',
});

describe('ControlServerRegistry', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('uses the shared LocalAppData contract path', () => {
    expect(controlServerRegistryPath('C:\\Users\\test\\AppData\\Local')).toBe(
      path.join('C:\\Users\\test\\AppData\\Local', 'forge-llm', 'control-server.json'),
    );
    expect(controlServerRegistryPath('')).toBeNull();
  });

  it('publishes atomically and replaces a stale owner record', () => {
    const { registry, filePath } = temporaryRegistry();
    registry.publish(record(100));
    registry.publish(record(200));

    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual(record(200));
    expect(fs.readdirSync(path.dirname(filePath))).toEqual(['control-server.json']);
  });

  it('removes the record only when the PID still matches', () => {
    const { registry, filePath } = temporaryRegistry();
    registry.publish(record(200));
    registry.removeIfOwned(100);
    expect(fs.existsSync(filePath)).toBe(true);

    registry.removeIfOwned(200);
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
