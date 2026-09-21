import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeFileAtomicSync } from '../../src/util/atomicWrite';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('writeFileAtomicSync', () => {
  it('refuses to overwrite a file that changed after it was read', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-atomic-'));
    roots.push(root);
    const target = path.join(root, 'value.txt');
    fs.writeFileSync(target, 'before');
    const stat = fs.statSync(target);
    fs.writeFileSync(target, 'user change');

    expect(() =>
      writeFileAtomicSync(target, 'agent change', {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
      }),
    ).toThrow(/changed while Forge was writing/i);
    expect(fs.readFileSync(target, 'utf8')).toBe('user change');
  });
});
