import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeSearchCodeTool } from '../../src/tools/dirTools';

describe('isolated search_code process execution', () => {
  let root: string;
  const fixture = path.resolve(__dirname, '../fixtures/fake-rg.mjs');

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-search-code-'));
    vscode.workspace.workspaceFolders.splice(0, Infinity, { uri: vscode.Uri.file(root) });
  });

  afterEach(() => {
    vscode.workspace.workspaceFolders.splice(0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  function tool() {
    return makeSearchCodeTool(() => ({
      command: process.execPath,
      argsPrefix: [fixture],
      candidates: [fixture],
    }));
  }

  it('spawns the resolved command, parses JSON events, and enforces the file-result limit', async () => {
    const result = await tool().handler({
      query: 'known fixture',
      include: '**/*.ts',
      max_results: 1,
    });
    expect(result).toContain('=== first.ts ===');
    expect(result).toContain('> 2: known fixture');
    expect(result).not.toContain('second.ts');
  });

  // Qwen searched for `--new` twice and gave up: rg took the query for a flag.
  it('passes a query that starts with dashes as the pattern, not a flag', async () => {
    const result = await tool().handler({ query: '--new', include: '**/*.ts', max_results: 1 });
    expect(result).toContain('> 2: --new');
  });

  it('searches an explicitly named absolute file outside the workspace', async () => {
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-search-external-'));
    const externalFile = path.join(externalRoot, 'server.py');
    fs.writeFileSync(externalFile, 'fixture');
    try {
      const result = await tool().handler({ query: 'needle', include: externalFile });
      expect(result).toContain(`=== ${externalFile.replace(/\\/g, '/')} ===`);
      expect(result).toContain('> 2: needle');
    } finally {
      fs.rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  it('searches an absolute glob under its external static directory', async () => {
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-search-external-'));
    try {
      const result = await tool().handler({
        query: 'needle',
        include: path.join(externalRoot, '**', '*.py'),
      });
      expect(result).toContain(`=== ${path.join(externalRoot, 'match.py').replace(/\\/g, '/')} ===`);
      expect(result).toContain('> 2: needle');
    } finally {
      fs.rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  it('kills the spawned search and reports caller cancellation', async () => {
    const controller = new AbortController();
    const pending = tool().handler(
      { query: 'slow fixture', include: '**/*.ts', max_results: 2 },
      { beforeMutate: () => undefined, abortSignal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toThrow('search_code: cancelled');
  });

  it('includes resolved command diagnostics when process startup fails', async () => {
    const missing = makeSearchCodeTool(() => ({
      command: path.join(root, 'missing-rg'),
      candidates: [path.join(root, 'candidate-rg')],
    }));
    await expect(missing.handler({ query: 'fixture' })).rejects.toThrow(
      /failed to start ripgrep command.*candidate-rg/s,
    );
  });
});
