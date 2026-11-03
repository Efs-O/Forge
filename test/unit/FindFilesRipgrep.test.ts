import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeFindFilesTool } from '../../src/tools/dirTools';

/**
 * Stands in for ripgrep so the tool's own parsing, capping and path
 * normalisation are covered without a binary on PATH. A real script file (not
 * `node -e`) so the appended ripgrep flags land as script arguments and are
 * ignored, rather than being parsed as node options.
 *
 * Ripgrep's own glob semantics are NOT exercised here.
 */
let scriptDir: string;

function stubRipgrep(lines: string[], captureArgs = false) {
  const file = path.join(scriptDir, `stub-${Math.random().toString(36).slice(2)}.js`);
  const output = captureArgs
    ? 'JSON.stringify(process.argv.slice(2))'
    : JSON.stringify(lines.join('\n'));
  fs.writeFileSync(file, `process.stdout.write(${output});`, 'utf8');
  return () => ({ command: process.execPath, argsPrefix: [file], candidates: [] as string[] });
}

describe('find_files backed by ripgrep', () => {
  beforeEach(() => {
    scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-find-files-'));
    vscode.workspace.workspaceFolders.splice(0, Infinity, { uri: vscode.Uri.file(process.cwd()) });
  });
  afterEach(() => {
    vscode.workspace.workspaceFolders.splice(0);
    fs.rmSync(scriptDir, { recursive: true, force: true });
  });

  it('returns normalised, sorted workspace-relative paths', async () => {
    // Windows separators and rg's "./" prefix must both come out as plain
    // workspace-relative paths — the form every other tool accepts.
    const backslash = String.fromCharCode(92);
    const tool = makeFindFilesTool(stubRipgrep([`./src${backslash}b.ts`, 'src/a.ts']));
    const out = await tool.handler({ pattern: '**/*.ts' }, undefined);
    expect(String(out).split('\n')).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('honours max_results', async () => {
    const tool = makeFindFilesTool(stubRipgrep(['a.ts', 'b.ts', 'c.ts', 'd.ts']));
    const out = await tool.handler({ pattern: '**/*.ts', max_results: 2 }, undefined);
    expect(String(out).split('\n')).toHaveLength(2);
  });

  it('keeps search exclusions when the named path is a directory', async () => {
    const tool = makeFindFilesTool(stubRipgrep([], true));
    const out = await tool.handler({ pattern: 'src' }, undefined);
    const args = JSON.parse(String(out)) as string[];
    for (const dir of ['.git', 'node_modules', 'dist', 'out']) {
      expect(args).toContain(`!**/${dir}/**`);
    }
  });

  it('explains the anchoring when nothing matches', async () => {
    // The failure this replaced returned a bare "No files match", which read as
    // "the file is absent" for paths that plainly existed.
    const tool = makeFindFilesTool(stubRipgrep([]));
    const out = await tool.handler({ pattern: 'tests/*' }, undefined);
    expect(String(out)).toContain('anchored at the workspace root');
    expect(String(out)).toContain('**/');
  });

  it('finds a gitignored file only when include_ignored is true', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-find-ignored-'));
    const relative = 'docs/plans/local-plan.md';
    try {
      fs.mkdirSync(path.join(root, 'docs', 'plans'), { recursive: true });
      fs.writeFileSync(path.join(root, '.gitignore'), 'docs/plans/\n');
      fs.writeFileSync(path.join(root, relative), 'local plan');
      vscode.workspace.workspaceFolders.splice(0, Infinity, { uri: vscode.Uri.file(root) });

      const script = path.join(scriptDir, 'ignore-aware-rg.js');
      fs.writeFileSync(
        script,
        `if (process.argv.includes('--no-ignore-vcs')) process.stdout.write(${JSON.stringify(relative)});`,
        'utf8',
      );
      const tool = makeFindFilesTool(() => ({ command: process.execPath, argsPrefix: [script] }));
      const missed = String(await tool.handler({ pattern: 'docs/plans/*' }, undefined));
      expect(missed).toContain('include_ignored: true');
      expect(await tool.handler({ pattern: 'docs/plans/*', include_ignored: true }, undefined)).toBe(
        relative,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an empty pattern before spawning anything', async () => {
    const tool = makeFindFilesTool(stubRipgrep([]));
    await expect(tool.handler({ pattern: '  ' }, undefined)).rejects.toThrow('non-empty string');
  });
});
