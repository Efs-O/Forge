import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll } from 'vitest';

/**
 * A hermetic fake CLI executable: a real, empty file whose basename infers as
 * `claude`, so `inferCliAgentName` accepts it and `resolveCliExecutable`
 * returns it without a PATH lookup. Call at a test file's top level: it
 * registers that file's `afterAll` to remove the folder.
 */
export function fakeClaudeCli(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-fake-cli-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
  fs.writeFileSync(file, '');
  return file;
}
