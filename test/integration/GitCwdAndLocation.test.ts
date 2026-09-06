import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { getRepo, getRepoForPaths, gitCwd, withGitError } from '../../src/tools/gitRepo';
import { makeGetDocumentSymbolsTool, makeGoToDefinitionTool } from '../../src/tools/lspTools';

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
}

/** Compare paths through realpath: on Windows the temp root is an 8.3 name. */
function samePath(a: string, b: string): boolean {
  return fs.realpathSync.native(a).toLowerCase() === fs.realpathSync.native(b).toLowerCase();
}

describe('git repository discovery', () => {
  let root: string;

  beforeEach(() => {
    // A workspace root that is NOT a repo, holding a real repo one level down —
    // the shape that made git_blame and git_show report "not a git repository"
    // while git_status, going through the VS Code Git API, worked fine.
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-git-cwd-'));
    initRepo(path.join(root, 'subproject'));
    fs.mkdirSync(path.join(root, 'subproject', 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'subproject', 'src', 'a.ts'), 'export const a = 1;', 'utf8');
    vscode.workspace.workspaceFolders.splice(0, Infinity, { uri: vscode.Uri.file(root) });
    // No Git extension: discovery must stand on the CLI alone.
    vi.spyOn(vscode.extensions, 'getExtension').mockReturnValue(undefined as never);
  });

  afterEach(() => {
    vscode.workspace.workspaceFolders.splice(0);
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('finds the repository containing the file, not the workspace root', async () => {
    expect(samePath(await gitCwd('subproject/src/a.ts'), path.join(root, 'subproject'))).toBe(true);
  });

  it('walks up from a nested directory to the repository root', async () => {
    expect(samePath(await gitCwd('subproject/src'), path.join(root, 'subproject'))).toBe(true);
  });

  it('resolves a file that does not exist yet, as stage must', async () => {
    expect(
      samePath(await gitCwd('subproject/src/not-created-yet.ts'), path.join(root, 'subproject')),
    ).toBe(true);
  });

  it('does not select an outer repository when the location is a nested repository', async () => {
    initRepo(root);
    expect(samePath(await gitCwd('subproject'), path.join(root, 'subproject'))).toBe(true);
  });

  it('does not let an outer repository the Git extension knows capture a nested one', async () => {
    // The extension's repository list is partial: it holds what VS Code
    // happened to discover. Selecting the deepest *known* root containing the
    // path silently staged nested work into the outer repository.
    initRepo(root);
    vi.mocked(vscode.extensions.getExtension).mockReturnValue({
      isActive: true,
      exports: { getAPI: () => ({ repositories: [{ rootUri: vscode.Uri.file(root) }] }) },
    } as never);
    const repo = await getRepo('subproject/src/a.ts');
    expect(samePath(repo.root, path.join(root, 'subproject'))).toBe(true);
  });

  it('finds a linked worktree, whose .git is a file rather than a directory', async () => {
    initRepo(root);
    fs.writeFileSync(path.join(root, 'seed.txt'), 'seed\n', 'utf8');
    const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t.invalid' };
    execFileSync('git', ['add', 'seed.txt'], { cwd: root, env });
    execFileSync('git', ['commit', '-m', 'seed'], { cwd: root, env });
    const linked = path.join(root, 'wt');
    execFileSync('git', ['worktree', 'add', '-b', 'side', linked], { cwd: root, env });
    expect(fs.statSync(path.join(linked, '.git')).isFile()).toBe(true);

    expect(samePath((await getRepo('wt')).root, linked)).toBe(true);
  });

  it('reports a path in no repository instead of silently using the workspace root', async () => {
    // The old fallback returned the workspace root and left git to produce its
    // own "not a git repository" message from somewhere the caller never named.
    await expect(gitCwd('nowhere/else.ts')).rejects.toThrow(/no git repository contains/u);
  });

  it('asks for a cwd when the workspace root is not a repository', async () => {
    await expect(gitCwd()).rejects.toThrow(/If the repository is in a subdirectory, pass cwd/u);
  });
});

describe('Git repository selection', () => {
  let root: string;
  let nested: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-git-repos-'));
    nested = path.join(root, 'subproject');
    initRepo(root);
    initRepo(nested);
    fs.mkdirSync(path.join(nested, 'src'), { recursive: true });
    fs.mkdirSync(path.join(nested, 'test'), { recursive: true });
    vscode.workspace.workspaceFolders.splice(0, Infinity, { uri: vscode.Uri.file(root) });
    vi.spyOn(vscode.extensions, 'getExtension').mockReturnValue(undefined as never);
  });

  afterEach(() => {
    vscode.workspace.workspaceFolders.splice(0);
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('selects the deepest repository containing an explicit cwd or file path', async () => {
    expect(samePath((await getRepo('subproject')).root, nested)).toBe(true);
    expect(samePath((await getRepoForPaths(['subproject/src/a.ts'])).root, nested)).toBe(true);
  });

  it('accepts multiple paths that resolve to the same repository', async () => {
    const repo = await getRepoForPaths(['subproject/src/a.ts', 'subproject/test/b.ts']);
    expect(samePath(repo.root, nested)).toBe(true);
  });

  it('still rejects a batch that resolves to different nested repositories', async () => {
    await expect(getRepoForPaths(['README.md', 'subproject/src/a.ts'])).rejects.toThrow(
      'paths belong to different repositories',
    );
  });

  it('requires a cwd rather than silently choosing one of several repositories', async () => {
    // Both roots are reachable without a location: the workspace root is a
    // repository and the Git extension has also discovered the nested one.
    vi.mocked(vscode.extensions.getExtension).mockReturnValue({
      isActive: true,
      exports: { getAPI: () => ({ repositories: [{ rootUri: vscode.Uri.file(nested) }] }) },
    } as never);
    await expect(getRepo()).rejects.toThrow('multiple repositories found; pass cwd');
  });

  it('does not report ambiguity when the extension repeats the workspace root', async () => {
    vi.mocked(vscode.extensions.getExtension).mockReturnValue({
      isActive: true,
      exports: { getAPI: () => ({ repositories: [{ rootUri: vscode.Uri.file(root) }] }) },
    } as never);
    expect(samePath((await getRepo()).root, root)).toBe(true);
  });

  it('activates an inactive Git extension before asking for its API', async () => {
    const activate = vi.fn(async () => undefined);
    vi.mocked(vscode.extensions.getExtension).mockReturnValue({
      isActive: false,
      activate,
      exports: { getAPI: () => ({ repositories: [] }) },
    } as never);
    await getRepo();
    expect(activate).toHaveBeenCalledOnce();
  });

  it('survives a Git extension whose API throws', async () => {
    vi.mocked(vscode.extensions.getExtension).mockReturnValue({
      isActive: true,
      get exports(): never {
        throw new Error('git extension is broken');
      },
    } as never);
    // The CLI still answers, so a broken extension is a logged fallback rather
    // than a failed tool call.
    expect(samePath((await getRepo('subproject')).root, nested)).toBe(true);
  });

  it('makes Git errors actionable by including the selected repository root', async () => {
    await expect(
      withGitError('git_commit', { root: nested }, async () => {
        throw new Error('Failed to execute git');
      }),
    ).rejects.toThrow(`git_commit failed in repository "${nested}": Failed to execute git`);
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

describe('LSP tools prime the language service', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-lsp-open-'));
    fs.writeFileSync(path.join(root, 'Game.js'), 'export class Game {}\n', 'utf8');
    vscode.workspace.workspaceFolders.splice(0, Infinity, { uri: vscode.Uri.file(root) });
  });

  afterEach(() => {
    vscode.workspace.workspaceFolders.splice(0);
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('opens the document before asking for symbols', async () => {
    // Providers analyse open documents. Querying a file nobody has opened
    // returned "No symbols found." for a file containing `export class Game`.
    const open = vi.spyOn(vscode.workspace, 'openTextDocument').mockResolvedValue({} as never);
    vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue([]);
    await makeGetDocumentSymbolsTool().handler({ path: 'Game.js' }, undefined);
    expect(open).toHaveBeenCalledOnce();
  });

  it('still answers when the document cannot be opened', async () => {
    // A binary or deleted file must not fail on the preparatory step — the
    // provider call should report the real problem.
    vi.spyOn(vscode.workspace, 'openTextDocument').mockRejectedValue(new Error('binary'));
    vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue([]);
    await expect(
      makeGetDocumentSymbolsTool().handler({ path: 'Game.js' }, undefined),
    ).resolves.toBe('No symbols found.');
  });
});
