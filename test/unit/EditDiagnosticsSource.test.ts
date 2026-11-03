import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The host-backed priming step in `editDiagnosticsSource.ts` — the open that
 * gives a language service something to report on. Every test here is about the
 * one decision that open makes past the workspace-root check: whether the file
 * is small enough that a service could answer inside the wait the note is
 * willing to spend. A 6 MB TypeScript file cannot be parsed and re-reported in
 * two seconds, so opening it is a document load, a stall and no answer, and the
 * note has to say that instead of "nothing reported on it".
 */
const { openTextDocument } = vi.hoisted(() => ({
  openTextDocument: vi.fn(async (_uri: unknown) => ({})),
}));

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [] as { uri: { fsPath: string } }[],
    openTextDocument,
  },
  languages: {
    getDiagnostics: () => [],
    onDidChangeDiagnostics: (_listener: unknown) => ({ dispose: () => {} }),
  },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
}));

import * as vscode from 'vscode';
import { vscodeDiagnosticsSource } from '../../src/tools/editDiagnosticsSource';

let root: string;
let source: ReturnType<typeof vscodeDiagnosticsSource>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-prime-'));
  (vscode.workspace as { workspaceFolders: { uri: { fsPath: string } }[] }).workspaceFolders = [
    { uri: { fsPath: root } },
  ];
  openTextDocument.mockClear();
  source = vscodeDiagnosticsSource()!;
  expect(source).toBeDefined();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the open that primes a closed file', () => {
  it('does not open a file above the bound, and says why in terms the note can use', async () => {
    const target = path.join(root, 'huge.ts');
    fs.writeFileSync(target, Buffer.alloc(6 * 1024 * 1024, 1));
    expect(await source.ensureChecked(target)).toMatch(
      /the file is 6\.0 MB and this host opens only files up to 5 MB for checking/,
    );
    expect(openTextDocument).not.toHaveBeenCalled();
  });

  it('opens a file below the bound, as it always did', async () => {
    const target = path.join(root, 'small.ts');
    fs.writeFileSync(target, 'const q = 1;\n');
    expect(await source.ensureChecked(target)).toBeUndefined();
    expect(openTextDocument).toHaveBeenCalledTimes(1);
  });

  it('skips a file outside every workspace root, and gives no reason for it', async () => {
    const outside = path.join(os.tmpdir(), `forge-prime-outside-${process.pid}.ts`);
    fs.writeFileSync(outside, 'const q = 1;\n');
    try {
      expect(await source.ensureChecked(outside)).toBeUndefined();
      expect(openTextDocument).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('says nothing about a file that is gone before the open lands, and fails nothing', async () => {
    expect(await source.ensureChecked(path.join(root, 'not-there.ts'))).toBeUndefined();
    expect(openTextDocument).not.toHaveBeenCalled();
  });
});
