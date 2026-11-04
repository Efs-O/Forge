import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeWriteFileTool } from '../../src/tools/builtinTools';
import { resolveRealWorkspacePath } from '../../src/util/WorkspacePaths';

describe('write_file line endings', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-write-eol-'));
    vscode.workspace.workspaceFolders.splice(0, Infinity, { uri: vscode.Uri.file(root) });
  });

  afterEach(() => {
    vscode.workspace.workspaceFolders.splice(0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (args: Record<string, unknown>) => makeWriteFileTool().handler(args);
  const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

  it('overwrites CRLF with LF input and reports that it kept CRLF', async () => {
    fs.writeFileSync(path.join(root, 'existing.txt'), 'old\r\nline\r\n');
    const result = await write({ path: 'existing.txt', content: 'new\nline\n' });
    expect(read('existing.txt')).toBe('new\r\nline\r\n');
    expect(result).toContain('(CRLF line endings, kept from the existing file)');
  });

  it('overwrites LF with CRLF input and reports LF', async () => {
    fs.writeFileSync(path.join(root, 'existing.txt'), 'old\nline\n');
    const result = await write({ path: 'existing.txt', content: 'new\r\nline\r\n' });
    expect(read('existing.txt')).toBe('new\nline\n');
    expect(result).toContain('(LF line endings, kept from the existing file)');
  });

  it('converts append chunks to the existing file style', async () => {
    fs.writeFileSync(path.join(root, 'existing.txt'), 'old\r\n');
    const result = await write({ path: 'existing.txt', content: 'next\n', mode: 'append' });
    expect(read('existing.txt')).toBe('old\r\nnext\r\n');
    expect(result).toContain('(CRLF line endings, kept from the existing file)');
  });

  it('uses Git eol attributes for new files, and leaves -text content unchanged', async () => {
    execFileSync('git', ['init'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'forge@test.invalid'], { cwd: root });
    fs.writeFileSync(
      path.join(root, '.gitattributes'),
      '* text eol=lf\n*.txt text eol=crlf\nblob.bin -text\n',
    );

    const tsResult = await write({ path: 'x.ts', content: 'const x = 1;\r\n' });
    const txtResult = await write({ path: 'a.txt', content: 'first\nsecond\n' });
    const binaryResult = await write({ path: 'blob.bin', content: 'first\r\nsecond\n' });

    expect(read('x.ts')).toBe('const x = 1;\n');
    expect(tsResult).toContain('(LF line endings, from Git eol=lf)');
    expect(read('a.txt')).toBe('first\r\nsecond\r\n');
    expect(txtResult).toContain('(CRLF line endings, from Git eol=crlf)');
    expect(read('blob.bin')).toBe('first\r\nsecond\n');
    expect(binaryResult).toBe(`Written ${await resolveRealWorkspacePath('blob.bin')}`);
  });

  it('defaults batch files to CRLF and other new files to LF outside a repository', async () => {
    const batResult = await write({ path: 'run.bat', content: 'echo one\necho two\n' });
    const cmdResult = await write({ path: 'RUN.CMD', content: 'echo one\necho two\n' });
    const notesResult = await write({ path: 'notes.md', content: 'one\ntwo\n' });

    expect(read('run.bat')).toBe('echo one\r\necho two\r\n');
    expect(batResult).toContain('(CRLF line endings, .bat file)');
    expect(read('RUN.CMD')).toBe('echo one\r\necho two\r\n');
    expect(cmdResult).toContain('(CRLF line endings, .cmd file)');
    expect(read('notes.md')).toBe('one\ntwo\n');
    expect(notesResult).toBe(`Written ${await resolveRealWorkspacePath('notes.md')}`);
  });

  it('keeps the existing result string when conversion is unnecessary', async () => {
    const result = await write({ path: 'plain.txt', content: 'one line' });
    expect(result).toBe(`Written ${await resolveRealWorkspacePath('plain.txt')}`);
  });
});
