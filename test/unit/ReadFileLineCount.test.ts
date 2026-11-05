import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: require('os').tmpdir() } }],
  },
}));

import { makeReadFileTool } from '../../src/tools/readFileTool';

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
  it('states numbered is a top-level option applied to every reads section', () => {
    const numbered = makeReadFileTool().definition.function.parameters?.properties['numbered'];
    expect(numbered?.description).toContain('Top-level option only');
    expect(numbered?.description).toContain('do not put it inside a reads item');
    expect(numbered?.description).toContain('every section of a reads call');
  });

  it('names both accepted fields and a minimal call when neither was supplied', async () => {
    await expect(read({})).rejects.toThrow(
      'neither path nor reads was given; minimal valid call: {"path":"src/a.ts"}',
    );
  });

  it('names an unknown top-level field and points to reads for multiple files', async () => {
    await expect(read({ paths: ['a.ts'] })).rejects.toThrow(
      'paths is not a read_file field; use reads: [{path, start_line, end_line}]',
    );
  });

  it('does not number a phantom line after the final newline', async () => {
    const target = path.join(dir, 'three.ts');
    fs.writeFileSync(target, 'a\nb\nc\n');
    expect(await read({ path: target, numbered: true })).toBe('1|a\n2|b\n3|c');
  });

  it('reports the real line count when a range runs past the end', async () => {
    const target = path.join(dir, 'three.ts');
    fs.writeFileSync(target, 'a\nb\nc\n');
    await expect(read({ path: target, start_line: 4 })).rejects.toThrow(
      'start_line 4 is past the end of the file (3 lines)',
    );
  });

  it('counts a file without a final newline the same way', async () => {
    const target = path.join(dir, 'open.ts');
    fs.writeFileSync(target, 'a\nb\nc');
    expect(await read({ path: target, numbered: true })).toBe('1|a\n2|b\n3|c');
  });

  it('refuses an oversized text file before reading it', async () => {
    const target = path.join(dir, 'large.txt');
    const fd = fs.openSync(target, 'w');
    fs.ftruncateSync(fd, 5);
    fs.closeSync(fd);

    await expect(
      makeReadFileTool({ maxTextFileBytes: 4 }).handler(
        { path: target, start_line: 1, end_line: 1 },
        { signal: new AbortController().signal } as never,
      ),
    ).rejects.toThrow(/Use search_code or the shell with a byte range/);
  });

  it('skips remaining batch paths after the result cap and reports each one', async () => {
    const first = path.join(dir, 'large-content.txt');
    const second = path.join(dir, 'not-read.txt');
    fs.writeFileSync(first, 'a'.repeat(120_000));
    const fd = fs.openSync(second, 'w');
    fs.ftruncateSync(fd, 200_001);
    fs.closeSync(fd);

    const result = await makeReadFileTool({ maxTextFileBytes: 200_000 }).handler(
      { reads: [{ path: first }, { path: second }] },
      { signal: new AbortController().signal } as never,
    );

    expect(result).toContain(`[skipped: result cap reached — read ${second} in another call]`);
    expect(result).not.toContain('over the 200000-byte text-file limit');
  });

  it.each([
    ['single path', { path: 'three.ts', start_line: '9000' }],
    ['batch item', { reads: [{ path: 'three.ts', end_line: 2.5 }] }],
    ['single path zero', { path: 'three.ts', end_line: 0 }],
    ['batch top-level string', { reads: [{ path: 'three.ts' }], start_line: '9000' }],
  ])('rejects invalid line ranges in the %s form', async (_label, args) => {
    await expect(read(args)).rejects.toThrow(/(?:start_line|end_line) must be a positive integer/);
  });

  it('coerces numeric strings in batch ranges and reads the whole batch', async () => {
    const first = path.join(dir, 'a.ts');
    const second = path.join(dir, 'b.ts');
    fs.writeFileSync(first, 'first\nsecond');
    fs.writeFileSync(second, 'other');
    const result = await read({ reads: [{ path: first, start_line: '1' }, { path: second }] });
    expect(result).toContain('--- ' + first);
    expect(result).toContain('first\nsecond');
    expect(result).toContain('--- ' + second);
    expect(result).toContain('other');
  });

  // The 50 MiB limit stays. What was wrong was the advice: `search_code` and a
  // byte range read text, and an Office document is a ZIP of deflated XML
  // parts while a PDF is compressed streams, so neither route gave anything
  // readable for those files — and view_image has its own 10 MiB PDF limit.
  // The ZIP routes also pin WHICH shell can run them: `unzip` is on the path in
  // Git Bash and not in the pwsh the shell tool defaults to on Windows, so an
  // advice that names only the command sends the agent to find that out.
  it.each([
    ['text file', 'large.txt', /Use search_code or the shell with a byte range/],
    ['DOCX', 'large.docx', /unzip -p .* word\/document\.xml.*shell: "bash"/],
    ['XLSX', 'large.xlsx', /unzip -p .* xl\/workbook\.xml.*shell: "bash"/],
    ['PPTX', 'large.pptx', /unzip -p .* ppt\/slides\/slide1\.xml.*shell: "bash"/],
    ['PDF', 'large.pdf', /split it with the shell first .*view_image with pages/],
    ['older Office format', 'large.doc', /Save it as \.docx, \.xlsx or \.pptx/],
  ])('refuses an oversized %s with a route that works on it', async (_label, name, route) => {
    const target = path.join(dir, name);
    fs.writeFileSync(target, Buffer.alloc(5));
    const tool = makeReadFileTool({ maxTextFileBytes: 4 });
    await expect(tool.handler({ path: target })).rejects.toThrow(route);
    await expect(tool.handler({ path: target })).rejects.toThrow(
      /is 5 bytes, over the 4-byte limit/,
    );
  });

  it('does not send a large Office document to search_code', async () => {
    const target = path.join(dir, 'bigdeck.pptx');
    fs.writeFileSync(target, Buffer.alloc(5));
    const message = String(
      await makeReadFileTool({ maxTextFileBytes: 4 })
        .handler({ path: target })
        .catch((error: unknown) => (error as Error).message),
    );
    expect(message).toMatch(/unzip -p/);
    expect(message).toMatch(/shell: "bash"/);
    expect(message).not.toMatch(/search_code/);
  });

  it('uses the same supported formats in the single and batch pages refusals', async () => {
    const target = path.join(dir, 'plain.txt');
    fs.writeFileSync(target, 'text');
    await expect(read({ path: target, pages: '1' })).rejects.toThrow(
      'pages is available for PDF, PPTX, and XLSX documents only',
    );
    const batch = await read({ reads: [{ path: target, pages: '1' }] });
    expect(batch).toContain('pages is available for PDF, PPTX, and XLSX documents only');
  });
});
