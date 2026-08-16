import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('vscode', () => ({ workspace: { workspaceFolders: undefined } }));

import { makeAppendFileTool, makeWriteFileTool } from '../../src/tools/builtinTools';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-append-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const call = async (tool: ReturnType<typeof makeAppendFileTool>, args: Record<string, unknown>) =>
  tool.handler(args, { signal: new AbortController().signal } as never);

describe('append_file', () => {
  // The point of the tool: a file too large for one call is built across
  // several, so no single tool call has to fit in the remaining context.
  it('reconstructs a file byte-exactly across a write and two appends', async () => {
    const target = path.join(dir, 'nested', 'ui.js');
    const chunks = ['"use strict";\n', 'const a = 1;\n', 'export default a;\n'];

    await call(makeWriteFileTool(), { path: target, content: chunks[0] });
    await call(makeAppendFileTool(), { path: target, content: chunks[1] });
    await call(makeAppendFileTool(), { path: target, content: chunks[2] });

    expect(fs.readFileSync(target, 'utf8')).toBe(chunks.join(''));
  });

  it('creates the file when it does not exist yet', async () => {
    const target = path.join(dir, 'fresh.txt');
    await call(makeAppendFileTool(), { path: target, content: 'first' });
    expect(fs.readFileSync(target, 'utf8')).toBe('first');
  });

  it('inserts no separator of its own', async () => {
    const target = path.join(dir, 'joined.txt');
    await call(makeAppendFileTool(), { path: target, content: 'a' });
    await call(makeAppendFileTool(), { path: target, content: 'b' });
    expect(fs.readFileSync(target, 'utf8')).toBe('ab');
  });

  it('is declared as a write-permission mutation so checkpoints capture it', () => {
    const tool = makeAppendFileTool();
    expect(tool.permission).toBe('write');
    expect(tool.mutation?.paths({ path: '/tmp/x' })).toEqual(['/tmp/x']);
  });

  it('tells both write tools to chunk large content', () => {
    const describe_ = (t: ReturnType<typeof makeAppendFileTool>) =>
      t.definition.function.description ?? '';
    expect(describe_(makeWriteFileTool())).toContain('append_file');
    expect(describe_(makeAppendFileTool())).toContain('append_file');
  });
});
