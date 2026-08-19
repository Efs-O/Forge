import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitCwd } from '../../src/tools/gitRepo';
import { makeGoToDefinitionTool } from '../../src/tools/lspTools';

describe('gitCwd', () => {
  let root: string;

  beforeEach(() => {
    // A workspace root that is NOT a repo, holding a repo one level down —
    // the shape that made git_blame and git_show report "not a git repository"
    // while git_status, going through the VS Code Git API, worked fine.
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-git-cwd-'));
    fs.mkdirSync(path.join(root, 'subproject', '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, 'subproject', 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'subproject', 'src', 'a.ts'), 'export const a = 1;', 'utf8');
    vscode.workspace.workspaceFolders.splice(0, Infinity, { uri: vscode.Uri.file(root) });
  });

  afterEach(() => {
    vscode.workspace.workspaceFolders.splice(0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('finds the repository containing the file, not the workspace root', () => {
    expect(gitCwd('subproject/src/a.ts')).toBe(path.join(root, 'subproject'));
  });

  it('walks up from a nested directory to the repository root', () => {
    expect(gitCwd('subproject/src')).toBe(path.join(root, 'subproject'));
  });

  it('falls back to the workspace root when no repository contains the path', () => {
    // git itself then produces the clearer message, rather than us guessing.
    expect(gitCwd('nowhere/else.ts')).toBe(root);
  });
});

describe('go_to_definition location rendering', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-lsp-loc-'));
    fs.writeFileSync(path.join(root, 'Game.js'), 'export class Game {}\n', 'utf8');
    vscode.workspace.workspaceFolders.splice(0, Infinity, { uri: vscode.Uri.file(root) });
  });

  afterEach(() => {
    vscode.workspace.workspaceFolders.splice(0);
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const range = (line: number, char: number) => ({
    start: { line, character: char },
    end: { line, character: char + 4 },
  });

  it('renders a LocationLink, which the JS/TS server actually returns', async () => {
    // Reading loc.range.start on one of these threw
    // "Cannot read properties of undefined (reading 'start')" — go_to_definition
    // failed on every JS file while find_references, which gets plain
    // Locations, worked.
    vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue([
      {
        targetUri: vscode.Uri.file(path.join(root, 'Game.js')),
        targetRange: range(0, 0),
        targetSelectionRange: range(0, 13),
      },
    ]);
    const out = await makeGoToDefinitionTool().handler({
      path: 'Game.js',
      line: 0,
      character: 13,
    });
    expect(String(out)).toContain('Game.js:1:14');
  });

  it('still renders a plain Location', async () => {
    vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue([
      { uri: vscode.Uri.file(path.join(root, 'Game.js')), range: range(2, 5) },
    ]);
    const out = await makeGoToDefinitionTool().handler({ path: 'Game.js', line: 2, character: 5 });
    expect(String(out)).toContain('Game.js:3:6');
  });

  it('reports no definition rather than throwing', async () => {
    vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue([]);
    await expect(
      makeGoToDefinitionTool().handler({ path: 'Game.js', line: 0, character: 0 }),
    ).resolves.toBe('No definition found.');
  });
});
