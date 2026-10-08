import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { readCallDiffBase } from '../../src/sidebar/callDiffBase';

describe('readCallDiffBase', () => {
  it('reads files, marks missing ones null and leaves directories out', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-call-diff-base-'));
    const file = path.join(dir, 'a.txt');
    const missing = path.join(dir, 'missing.txt');
    fs.writeFileSync(file, 'hello\n');
    try {
      const base = readCallDiffBase([file, missing, dir]);
      expect(base.get(file)).toBe('hello\n');
      expect(base.get(missing)).toBeNull();
      expect(base.has(dir)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
