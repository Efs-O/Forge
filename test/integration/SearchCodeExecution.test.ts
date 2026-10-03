import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeSearchCodeTool } from '../../src/tools/dirTools';
import { resolveRipgrep } from '../../src/tools/RipgrepResolver';
import { resolveLiveAppRoot } from '../live/liveModelHarness';

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

  // The exclusion list is what stops a search drowning in node_modules and the
  // embeddings index. The fixture used to ignore the glob arguments, so dropping
  // every one of them still passed (audit F1, 2026-10-03). Naming the workspace
  // root as an absolute path is the case that did exactly that.
  it('passes every exclusion when the caller names a directory', async () => {
    const result = await tool().handler({ query: 'args fixture', include: root });
    for (const glob of ['!**/.git/**', '!**/node_modules/**', '!**/dist/**', '!**/out/**']) {
      expect(result).toContain(glob);
    }
    expect(result).toContain('--no-ignore-vcs');
  });

  it('passes every exclusion for a relative wildcard include', async () => {
    const result = await tool().handler({ query: 'args fixture', include: '**/*.ts' });
    expect(result).toContain('!**/node_modules/**');
    expect(result).toContain('--glob **/*.ts');
    expect(result).not.toContain('--no-ignore-vcs');
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

/**
 * The argv assertions above prove the tool SENDS the exclusions; this proves
 * real ripgrep AGREES with them. Skipped unless a ripgrep binary actually
 * exists on disk — a CI runner may have `code` on PATH but no unpacked rg, and
 * `resolveRipgrep` then falls back to the bare name, which would fail here for
 * the wrong reason (audit F1 follow-up, Codex review, 2026-10-03).
 */
const bundledRg = resolveRipgrep(resolveLiveAppRoot());
const realRg = fs.existsSync(bundledRg.command) ? bundledRg : undefined;

describe.skipIf(realRg === undefined)('search_code against the bundled ripgrep', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-search-real-'));
    vscode.workspace.workspaceFolders.splice(0, Infinity, { uri: vscode.Uri.file(root) });
    for (const [file, text] of [
      ['keep.ts', 'needle here'],
      ['node_modules/pkg/index.txt', 'needle here'],
      ['dist/bundle.js', 'needle here'],
      ['.git/COMMIT_EDITMSG', 'needle here'],
    ] as const) {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    }
  });

  afterEach(() => {
    vscode.workspace.workspaceFolders.splice(0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  function tool() {
    return makeSearchCodeTool(() => realRg!);
  }

  // The F1 failure itself: naming the workspace root used to drop every
  // exclusion, so this returned node_modules, dist and .git matches.
  it('omits noise directories when the caller names the workspace root', async () => {
    const result = await tool().handler({ query: 'needle here', include: root });
    expect(result).toContain('keep.ts');
    expect(result).not.toContain('node_modules');
    expect(result).not.toContain('bundle.js');
    expect(result).not.toContain('COMMIT_EDITMSG');
  });

  it('still searches a deliberately named file inside an excluded directory', async () => {
    // Naming `dist/bundle.js` in full is an explicit request for THAT file —
    // rgScopeArgs drops the exclusions exactly here, and this is the proof the
    // exception is not over-broad in the other direction.
    const named = path.join(root, 'dist', 'bundle.js');
    const result = await tool().handler({ query: 'needle here', include: named });
    expect(result).toContain('bundle.js');
    expect(result).toContain('needle here');
  });

  it('omits noise directories for a relative wildcard include', async () => {
    const result = await tool().handler({ query: 'needle here', include: '**/*' });
    expect(result).toContain('keep.ts');
    expect(result).not.toContain('node_modules');
    expect(result).not.toContain('bundle.js');
  });
});
