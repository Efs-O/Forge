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
