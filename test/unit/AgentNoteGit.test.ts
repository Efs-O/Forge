/**
 * The rule the 0.17.206 laptop audit asked for: Forge's agent note never goes
 * into a file the repository commits, and a file Forge creates inside a
 * repository is listed in `.git/info/exclude` first, then taken out of it again
 * with the note.
 *
 * Every case here runs against a real repository: `git init` in a fresh
 * temporary folder, committed with a local identity, and `git status
 * --porcelain` is the assertion — it is what the owner would see, and it is the
 * only proof that "the note is in the working tree" and "the note is in git" are
 * still two different things. The folders are outside any repository of their
 * own, so the "no repository here" cases are the same code path a user's
 * non-git folder takes.
 *
 * Nothing here touches the operator's `~/.forge`: the registry is always a path
 * in the test's own folder.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_NOTE_START,
  buildAgentMeshNote,
  type AgentMeshNoteFacts,
} from '../../src/agentBus/agentMeshNote';
import {
  addExcludeLine,
  classifyNoteTarget,
  EXCLUDE_BLOCK_END,
  EXCLUDE_BLOCK_START,
  NOTE_SKIP_IMPORT_PARENT,
  NOTE_SKIP_TRACKED,
  NOTE_SKIP_UNTRACKED,
  noteSkipGitUnreachable,
  removeExcludeLine,
  type NoteExcludeTarget,
} from '../../src/agentBus/agentNoteGit';
import {
  noteFilesRegistryPath,
  readNoteFiles,
  recordNoteFiles,
  removeWorkspaceAgentNotes,
} from '../../src/agentBus/agentNoteRemoval';
import { installAgentMeshNote, refreshAgentMeshNote } from '../../src/vscode/agentMeshNoteSetup';
import { runUninstall } from '../../src/uninstall';
import { removeTreeWhenFree } from '../support/removeTempTree';

const facts: AgentMeshNoteFacts = {
  busDir: 'C:/Users/tester/.forge/agent-bus',
  configPath: 'C:/Users/tester/.forge/config.yaml',
  meshState: 'control server on, port 8799 (loopback only); agent bus on',
};
const note = buildAgentMeshNote(facts);
/** A note whose text differs, so a refresh has something to replace: writing
 *  `note` and refreshing with `facts` would be an `unchanged`, not a `replaced`. */
const staleNote = buildAgentMeshNote({ ...facts, meshState: 'control server off' });

/** Run `git` with no shell: the classification code spawns it with
 *  `execFileSync` and `shell: false`, so the fixtures must not disagree with it
 *  about which git is being talked to, or answer through a bash that a
 *  Windows-only path would not have. */
function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    shell: false,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** A repository of its own: identity set locally (so a commit never needs the
 *  operator's), no GPG, and `core.excludesFile` pointed at a file that does not
 *  exist, so a global ignore file on the machine cannot decide "ignored" for a
 *  test that is asserting "untracked". */
function initRepo(dir: string, name = 'repo'): string {
  const root = path.join(dir, name);
  fs.mkdirSync(root, { recursive: true });
  git(root, ['init']);
  git(root, ['config', 'user.name', 'Forge Test']);
  git(root, ['config', 'user.email', 'forge-test@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['config', 'core.excludesFile', path.join(root, 'no-global-excludes')]);
  return root;
}

function write(root: string, name: string, content: string): string {
  const filePath = path.join(root, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function commit(root: string, message: string): void {
  git(root, ['add', '--', '.']);
  git(root, ['commit', '--no-verify', '-m', message]);
}

function status(root: string): string {
  return git(root, ['status', '--porcelain']);
}

/** Where Forge would write its exclude lines for this root — the same question
 *  `excludeTarget` answers, so a worktree's own path is never guessed. */
function excludeFileOf(root: string): string {
  return path.resolve(root, git(root, ['rev-parse', '--git-path', 'info/exclude']).trim());
}

/** The lines inside Forge's block, markers included; empty when there is no
 *  block. Read this way, a wrong pattern or a stray line fails the test instead
 *  of hiding inside a longer string. */
function blockOf(excludeContent: string): string[] {
  const match = new RegExp(
    `${EXCLUDE_BLOCK_START.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\r?\\n([\\s\\S]*?)\\r?\\n${EXCLUDE_BLOCK_END.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`,
    'u',
  ).exec(excludeContent);
  if (match === null) return [];
  return [EXCLUDE_BLOCK_START, ...match[1].split(/\r?\n/u), EXCLUDE_BLOCK_END];
}

const namesAndStatuses = (results: { path: string; status: string }[]): [string, string][] =>
  results.map((result) => [path.basename(result.path), result.status]);

let dir: string;
let registry: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'note-git-'));
  registry = path.join(dir, 'note-files.json');
});
afterEach(async () => {
  await removeTreeWhenFree(dir);
});

describe('a repository that commits the note files', () => {
  it('leaves tracked AGENTS.md and CLAUDE.md byte for byte, and the tree clean', () => {
    const root = initRepo(dir);
    const own = { 'AGENTS.md': '# Mine\n\nMy rules.\n', 'CLAUDE.md': '# Claude\n\nMy rules.\n' };
    for (const [name, content] of Object.entries(own)) write(root, name, content);
    git(root, ['add', '--', 'AGENTS.md', 'CLAUDE.md']);
    commit(root, 'own instruction files');

    const installed = installAgentMeshNote([root], facts, registry);
    expect(namesAndStatuses(installed)).toEqual([
      ['AGENTS.md', 'skipped'],
      ['CLAUDE.md', 'skipped'],
    ]);
    expect(installed[0]?.reason).toBe(NOTE_SKIP_TRACKED);
    expect(installed[1]?.reason).toBe(NOTE_SKIP_TRACKED);
    // A refresh is refused by the same rule, not by a section that is missing.
    expect(namesAndStatuses(refreshAgentMeshNote([root], facts, registry))).toEqual([
      ['AGENTS.md', 'skipped'],
      ['CLAUDE.md', 'skipped'],
    ]);

    for (const [name, content] of Object.entries(own)) {
      expect(fs.readFileSync(path.join(root, name), 'utf8')).toBe(content);
    }
    expect(status(root)).toBe('');
    // Nothing was excluded, because nothing was written.
    expect(blockOf(fs.readFileSync(excludeFileOf(root), 'utf8'))).toEqual([]);
    expect(readNoteFiles(registry)).toEqual([]);
  });

  it('creates AGENTS.md but leaves a tracked CLAUDE.md alone', () => {
    const root = initRepo(dir);
    write(root, 'CLAUDE.md', '# Claude\n\nMy rules.\n');
    git(root, ['add', '--', 'CLAUDE.md']);
    commit(root, 'own CLAUDE.md');

    const results = installAgentMeshNote([root], facts, registry);
    expect(namesAndStatuses(results)).toEqual([
      ['AGENTS.md', 'created'],
      ['CLAUDE.md', 'skipped'],
    ]);
    expect(results[1]?.reason).toBe(NOTE_SKIP_TRACKED);
    expect(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')).toContain(AGENT_NOTE_START);
    expect(blockOf(fs.readFileSync(excludeFileOf(root), 'utf8'))).toEqual([
      EXCLUDE_BLOCK_START,
      '/AGENTS.md',
      EXCLUDE_BLOCK_END,
    ]);
    expect(status(root)).toBe('');
  });

  it('does not create a CLAUDE.md that would only import a skipped AGENTS.md', () => {
    const root = initRepo(dir);
    write(root, 'AGENTS.md', '# Mine\n\nMy rules.\n');
    git(root, ['add', '--', 'AGENTS.md']);
    commit(root, 'own AGENTS.md');

    const results = installAgentMeshNote([root], facts, registry);
    expect(namesAndStatuses(results)).toEqual([
      ['AGENTS.md', 'skipped'],
      ['CLAUDE.md', 'skipped'],
    ]);
    expect(results[0]?.reason).toBe(NOTE_SKIP_TRACKED);
    expect(results[1]?.reason).toBe(NOTE_SKIP_IMPORT_PARENT);
    expect(fs.existsSync(path.join(root, 'CLAUDE.md'))).toBe(false);
    expect(status(root)).toBe('');
    expect(blockOf(fs.readFileSync(excludeFileOf(root), 'utf8'))).toEqual([]);
  });
});

describe('a repository that would commit a file Forge creates', () => {
  it('creates both files in an empty repository and lists them in info/exclude', () => {
    const root = initRepo(dir);
    const exclude = excludeFileOf(root);
    const original = fs.readFileSync(exclude, 'utf8');

    const results = installAgentMeshNote([root], facts, registry);
    expect(namesAndStatuses(results)).toEqual([
      ['AGENTS.md', 'created'],
      ['CLAUDE.md', 'created'],
    ]);
    recordNoteFiles(registry, results);

    const content = fs.readFileSync(exclude, 'utf8');
    expect(content.slice(0, original.length)).toBe(original);
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    expect(content.slice(original.length)).toBe(
      `${EXCLUDE_BLOCK_START}${eol}/AGENTS.md${eol}/CLAUDE.md${eol}${EXCLUDE_BLOCK_END}${eol}`,
    );
    expect(status(root)).toBe('');
    expect(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')).toContain(AGENT_NOTE_START);
    expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n');

    const records = readNoteFiles(registry);
    expect(records.map((record) => [path.basename(record.path), record.created])).toEqual([
      ['AGENTS.md', true],
      ['CLAUDE.md', true],
    ]);
    expect(records.map((record) => record.exclude)).toEqual([
      { file: exclude, line: '/AGENTS.md' },
      { file: exclude, line: '/CLAUDE.md' },
    ]);
  });

  it('writes a file git already ignores, and adds no exclude line', () => {
    const root = initRepo(dir);
    write(root, '.gitignore', 'AGENTS.md\nCLAUDE.md\n');
    git(root, ['add', '--', '.gitignore']);
    commit(root, 'ignore the note files');

    const results = installAgentMeshNote([root], facts, registry);
    expect(namesAndStatuses(results)).toEqual([
      ['AGENTS.md', 'created'],
      ['CLAUDE.md', 'created'],
    ]);
    expect(results.every((result) => result.exclude === undefined)).toBe(true);
    expect(blockOf(fs.readFileSync(excludeFileOf(root), 'utf8'))).toEqual([]);
    expect(status(root)).toBe('');
  });

  it('leaves the owner’s own untracked AGENTS.md byte for byte', () => {
    const root = initRepo(dir);
    write(root, 'README.md', '# Mine\n');
    commit(root, 'readme');
    const own = '# Mine\n\nMy rules.\n';
    const agents = write(root, 'AGENTS.md', own);

    const results = installAgentMeshNote([root], facts, registry);
    expect(namesAndStatuses(results)).toEqual([
      ['AGENTS.md', 'skipped'],
      ['CLAUDE.md', 'skipped'],
    ]);
    expect(results[0]?.reason).toBe(NOTE_SKIP_UNTRACKED);
    // The `CLAUDE.md` that would only have imported it is not created either:
    // an import of a file with no note in it carries no note.
    expect(results[1]?.reason).toBe(NOTE_SKIP_IMPORT_PARENT);
    expect(fs.existsSync(path.join(root, 'CLAUDE.md'))).toBe(false);
    expect(fs.readFileSync(agents, 'utf8')).toBe(own);
    // Only Forge's own file is invisible to git: the owner's file still shows
    // up as untracked, exactly as it did before Forge ran.
    expect(status(root)).toBe('?? AGENTS.md\n');
    // Nothing was excluded, because nothing was written.
    expect(blockOf(fs.readFileSync(excludeFileOf(root), 'utf8'))).toEqual([]);
  });

  it('refreshes an untracked file the registry says Forge created, and excludes it', () => {
    const root = initRepo(dir);
    write(root, 'README.md', '# Mine\n');
    commit(root, 'readme');
    const agents = write(root, 'AGENTS.md', `own\n\n${staleNote}\n`);
    recordNoteFiles(registry, [{ path: agents, status: 'created' }]);

    const results = refreshAgentMeshNote([root], facts, registry);
    expect(namesAndStatuses(results)).toEqual([
      ['AGENTS.md', 'replaced'],
      ['CLAUDE.md', 'skipped'],
    ]);
    const content = fs.readFileSync(agents, 'utf8');
    expect(content.startsWith('own\n\n')).toBe(true);
    expect(content).toContain(note.trimEnd());
    expect(content).not.toContain('control server off');
    expect(blockOf(fs.readFileSync(excludeFileOf(root), 'utf8'))).toEqual([
      EXCLUDE_BLOCK_START,
      '/AGENTS.md',
      EXCLUDE_BLOCK_END,
    ]);
    expect(status(root)).toBe('');
  });

  it('puts the exclude line in the exclude file that worktree asks for', () => {
    const root = initRepo(dir);
    write(root, 'README.md', '# Mine\n');
    commit(root, 'readme');
    const worktree = path.join(dir, 'worktree');
    git(root, ['worktree', 'add', '--detach', worktree]);

    const results = installAgentMeshNote([worktree], facts, registry);
    expect(namesAndStatuses(results)).toEqual([
      ['AGENTS.md', 'created'],
      ['CLAUDE.md', 'created'],
    ]);
    // The exclude file is whatever `--git-path info/exclude` names for THAT
    // folder — which is the whole reason the path is asked and not assumed:
    // git keeps `info/exclude` in the directory the worktrees share, so
    // `<worktree>/.git` is a file, not a folder, and a guessed path would not
    // even be writable. The pattern is still anchored at the worktree's root.
    expect(blockOf(fs.readFileSync(excludeFileOf(worktree), 'utf8'))).toEqual([
      EXCLUDE_BLOCK_START,
      '/AGENTS.md',
      '/CLAUDE.md',
      EXCLUDE_BLOCK_END,
    ]);
    // The checkout the worktree came from gets no note file, and stays clean.
    expect(fs.existsSync(path.join(root, 'AGENTS.md'))).toBe(false);
    expect(status(root)).toBe('');
    expect(status(worktree)).toBe('');
  });

  it('lists a subfolder workspace by its path in the repository', () => {
    const root = initRepo(dir);
    write(root, 'README.md', '# Mine\n');
    write(root, path.join('pkg', 'keep.txt'), 'tracked\n');
    commit(root, 'readme and a package folder');
    const pkg = path.join(root, 'pkg');

    const results = installAgentMeshNote([pkg], facts, registry);
    expect(namesAndStatuses(results)).toEqual([
      ['AGENTS.md', 'created'],
      ['CLAUDE.md', 'created'],
    ]);
    expect(blockOf(fs.readFileSync(excludeFileOf(pkg), 'utf8'))).toEqual([
      EXCLUDE_BLOCK_START,
      '/pkg/AGENTS.md',
      '/pkg/CLAUDE.md',
      EXCLUDE_BLOCK_END,
    ]);
    expect(status(root)).toBe('');
  });
});

describe('what git says about one note file', () => {
  it('answers outside a repository, untracked, tracked and ignored', () => {
    expect(classifyNoteTarget(dir, 'AGENTS.md')).toBe('outside-repo');
    const root = initRepo(dir);
    expect(classifyNoteTarget(root, 'AGENTS.md')).toBe('untracked');
    write(root, 'AGENTS.md', 'mine\n');
    expect(classifyNoteTarget(root, 'AGENTS.md')).toBe('untracked');
    git(root, ['add', '--', 'AGENTS.md']);
    expect(classifyNoteTarget(root, 'AGENTS.md')).toBe('tracked');
    write(root, '.gitignore', 'ignored.md\n');
    expect(classifyNoteTarget(root, 'ignored.md')).toBe('ignored');
    expect(classifyNoteTarget(root, 'not-there.md')).toBe('untracked');
  });

  it('skips both files when a repository is here but git would not start', async () => {
    const root = initRepo(dir);
    write(root, 'README.md', '# Mine\n');
    commit(root, 'readme');
    vi.resetModules();
    vi.doMock('child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('child_process')>();
      return {
        ...actual,
        execFileSync: (): string => {
          throw Object.assign(new Error('spawnSync git ENOENT'), {
            code: 'ENOENT',
            status: null,
            stdout: '',
            stderr: '',
          });
        },
      };
    });
    try {
      const setup = await import('../../src/vscode/agentMeshNoteSetup');
      const results = setup.installAgentMeshNote([root], facts, registry);
      expect(namesAndStatuses(results)).toEqual([
        ['AGENTS.md', 'skipped'],
        ['CLAUDE.md', 'skipped'],
      ]);
      expect(results[0]?.reason).toBe(noteSkipGitUnreachable('spawnSync git ENOENT'));
      expect(results[1]?.reason).toMatch(
        /^inside a git repository, but git did not run \(/u,
      );
      expect(fs.existsSync(path.join(root, 'AGENTS.md'))).toBe(false);
      expect(blockOf(fs.readFileSync(excludeFileOf(root), 'utf8'))).toEqual([]);
    } finally {
      vi.doUnmock('child_process');
      vi.resetModules();
    }
  });
});

describe('taking Forge’s exclude lines back out', () => {
  it('removes both files and the block with them, keeping a line above it', () => {
    const root = initRepo(dir);
    const exclude = excludeFileOf(root);
    const original = fs.readFileSync(exclude, 'utf8');
    fs.writeFileSync(exclude, `${original}/ref1.jpg\n`);
    const installed = installAgentMeshNote([root], facts, registry);
    recordNoteFiles(registry, installed);
    expect(fs.existsSync(path.join(root, 'AGENTS.md'))).toBe(true);
    expect(removeWorkspaceAgentNotes([root], registry).map((r) => r.status)).toEqual([
      'deleted',
      'deleted',
    ]);
    expect(fs.existsSync(path.join(root, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'CLAUDE.md'))).toBe(false);
    expect(fs.readFileSync(exclude, 'utf8')).toBe(`${original}/ref1.jpg\n`);
    expect(readNoteFiles(registry)).toEqual([]);
  });

  it('does the same on uninstall, with no git asked at all', () => {
    const home = fs.mkdtempSync(path.join(dir, 'home-'));
    const root = initRepo(dir);
    const exclude = excludeFileOf(root);
    const original = fs.readFileSync(exclude, 'utf8');
    const installed = installAgentMeshNote([root], facts, noteFilesRegistryPath(home));
    recordNoteFiles(noteFilesRegistryPath(home), installed);

    expect(runUninstall(home).map((r) => r.status)).toEqual(['deleted', 'deleted']);
    expect(fs.existsSync(path.join(root, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'CLAUDE.md'))).toBe(false);
    expect(fs.readFileSync(exclude, 'utf8')).toBe(original);
    expect(fs.existsSync(noteFilesRegistryPath(home))).toBe(false);
  });

  it('adds the line once, and removes the block when its only line goes', () => {
    const target: NoteExcludeTarget = {
      file: path.join(dir, 'repo', '.git', 'info', 'exclude'),
      line: '/AGENTS.md',
    };
    addExcludeLine(target);
    addExcludeLine(target);
    expect(fs.readFileSync(target.file, 'utf8')).toBe(
      `${EXCLUDE_BLOCK_START}\n/AGENTS.md\n${EXCLUDE_BLOCK_END}\n`,
    );
    removeExcludeLine(target);
    expect(fs.readFileSync(target.file, 'utf8')).toBe('');
    // An absent file, and a line that is not in the block, are both nothing to do.
    removeExcludeLine(target);
    expect(fs.readFileSync(target.file, 'utf8')).toBe('');
  });

  it('keeps a CRLF exclude file CRLF, and the owner’s lines byte for byte', () => {
    const file = path.join(dir, 'repo', '.git', 'info', 'exclude');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# mine\r\n/ref1.jpg\r\n');
    const agents: NoteExcludeTarget = { file, line: '/AGENTS.md' };
    addExcludeLine(agents);
    addExcludeLine(agents);
    expect(fs.readFileSync(file, 'utf8')).toBe(
      `# mine\r\n/ref1.jpg\r\n${EXCLUDE_BLOCK_START}\r\n/AGENTS.md\r\n${EXCLUDE_BLOCK_END}\r\n`,
    );

    const claude: NoteExcludeTarget = { file, line: '/CLAUDE.md' };
    addExcludeLine(claude);
    expect(blockOf(fs.readFileSync(file, 'utf8'))).toEqual([
      EXCLUDE_BLOCK_START,
      '/AGENTS.md',
      '/CLAUDE.md',
      EXCLUDE_BLOCK_END,
    ]);
    // One line goes, the block stays for the other.
    removeExcludeLine(agents);
    expect(fs.readFileSync(file, 'utf8')).toBe(
      `# mine\r\n/ref1.jpg\r\n${EXCLUDE_BLOCK_START}\r\n/CLAUDE.md\r\n${EXCLUDE_BLOCK_END}\r\n`,
    );
    removeExcludeLine(claude);
    expect(fs.readFileSync(file, 'utf8')).toBe('# mine\r\n/ref1.jpg\r\n');
  });
});
