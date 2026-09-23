import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: require('os').tmpdir() } }],
  },
}));

import { makeReadFileTool } from '../../src/tools/builtinTools';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-readlines-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const read = async (args: Record<string, unknown>) =>
  makeReadFileTool().handler(args, { signal: new AbortController().signal } as never);

// ESLint max-lines and `wc -l` both count a newline-terminated 500-line file as
// 500. read_file used to number an empty line 501 after it, and Qwen split
// files the lint gate had already accepted.
describe('read_file line count', () => {
  it('does not number a phantom line after the final newline', async () => {
    const target = path.join(dir, 'three.ts');
    fs.writeFileSync(target, 'a\nb\nc\n');
    expect(await read({ path: target, numbered: true })).toBe('1|a\n2|b\n3|c');
  });

  it('reports the real line count when a range runs past the end', async () => {
    const target = path.join(dir, 'three.ts');
    fs.writeFileSync(target, 'a\nb\nc\n');
    await expect(read({ path: target, start_line: 4 })).rejects.toThrow('file has 3 lines');
  });

  it('counts a file without a final newline the same way', async () => {
    const target = path.join(dir, 'open.ts');
    fs.writeFileSync(target, 'a\nb\nc');
    expect(await read({ path: target, numbered: true })).toBe('1|a\n2|b\n3|c');
  });
});
