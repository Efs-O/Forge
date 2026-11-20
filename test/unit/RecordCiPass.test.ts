/**
 * The recorded green run (`scripts/record-ci-pass.mjs`) is the one thing the push gate cannot
 * check for itself, so it is the thing that used to be faked: `check-push.mjs --record-ci`
 * wrote the marker without running anything, and on 2026-11-12 a pass was recorded over a red
 * suite. The proof now comes from the run itself, which reaches the recorder only when every
 * step exited 0.
 *
 * These tests pin what makes that proof mean something: it names the tree the run actually
 * read (working tree, uncommitted edits included), it is marked again under the tree a commit
 * could have when untracked files sit in the repo, a marker that cannot be read is never a
 * pass, and the directory stays bounded.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  KEEP_MARKERS,
  markerName,
  prune,
  readMarker,
  record,
  treeHashOfHead,
  treeHashOfTrackedTree,
  treeHashOfWorkingTree,
  untrackedPaths,
} from '../../scripts/record-ci-pass.mjs';

let dir: string;
let repo: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-ci-pass-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (repo) rmSync(repo, { recursive: true, force: true });
  repo = undefined;
});

const TREE = 'a'.repeat(40);
const hex = (i: number) => i.toString(16).padStart(40, '0');

describe('the recorded CI pass', () => {
  it('names the tree it was recorded for, so the gate can match it', () => {
    const file = record({ dir, treeHash: TREE, at: '2026-11-12T00:00:00.000Z' });
    expect(file.endsWith(markerName(TREE))).toBe(true);
    expect(readMarker(dir, TREE)).toMatchObject({ tree: TREE, at: '2026-11-12T00:00:00.000Z' });
  });

  it('is absent — never a pass — when the marker is missing, malformed, or for another tree', () => {
    expect(readMarker(dir, TREE)).toBeUndefined();
    writeFileSync(join(dir, markerName(TREE)), '{"tree":"oth');
    expect(readMarker(dir, TREE)).toBeUndefined();
    writeFileSync(join(dir, markerName(TREE)), JSON.stringify({ tree: 'b'.repeat(40) }));
    expect(readMarker(dir, TREE)).toBeUndefined();
  });

  it('writes through a temporary name, so a half-written run leaves no marker', () => {
    writeFileSync(join(dir, `${markerName(TREE)}.writing`), '{"tree":"partial');
    expect(readMarker(dir, TREE)).toBeUndefined();
    expect(existsSync(join(dir, markerName(TREE)))).toBe(false);
  });

  it('keeps only the newest markers, so the directory does not grow forever', () => {
    const total = KEEP_MARKERS + 5;
    for (let i = 0; i < total; i++) {
      record({ dir, treeHash: hex(i), at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() });
    }
    expect(prune(dir)).toHaveLength(5);
    expect(readdirSync(dir)).toHaveLength(KEEP_MARKERS);
    expect(readMarker(dir, hex(total - 1))).toBeDefined();
    expect(readMarker(dir, hex(0))).toBeUndefined();
  });

  it('survives a marker it cannot date, and never deletes the newest', () => {
    const undated = 'c'.repeat(40);
    writeFileSync(join(dir, markerName(undated)), JSON.stringify({ tree: undated }));
    const newest = 'd'.repeat(40);
    record({ dir, treeHash: newest, at: new Date(Date.now() + 60_000).toISOString() });
    expect(() => prune(dir, 1)).not.toThrow();
    expect(readMarker(dir, newest)).toBeDefined();
  });
});

/**
 * `npm run ci` tests the working tree, so a pass recorded under HEAD's tree while a file is
 * dirty certifies bytes the suite never read. The recorder therefore hashes the working tree in
 * a throw-away index — without touching the repository's real index, which other agents share.
 */
function gitIn(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function repoWithOneCommit(): string {
  repo = mkdtempSync(join(tmpdir(), 'forge-ci-tree-'));
  gitIn(repo, ['init', '-q', '-b', 'main']);
  gitIn(repo, ['config', 'user.name', 'Forge Test']);
  gitIn(repo, ['config', 'user.email', 'forge@test.invalid']);
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  gitIn(repo, ['add', 'a.txt']);
  gitIn(repo, ['commit', '-q', '-m', 'chore: base']);
  return repo;
}

describe('the tree a recorded pass is keyed by', () => {
  it("is HEAD's tree exactly when nothing is uncommitted", () => {
    const root = repoWithOneCommit();
    expect(treeHashOfWorkingTree(root)).toBe(treeHashOfHead(root));
  });

  it('names the working tree when a tracked file is edited and never committed', () => {
    const root = repoWithOneCommit();
    writeFileSync(join(root, 'a.txt'), 'edited, still uncommitted\n');
    const head = treeHashOfHead(root);
    const work = treeHashOfWorkingTree(root);
    expect(work).not.toBe(head);
    // Committing that same edit is what makes the recorded pass count for the push.
    gitIn(root, ['add', '-A']);
    gitIn(root, ['commit', '-q', '-m', 'fix: the edit']);
    expect(treeHashOfHead(root)).toBe(work);
  });

  it('includes an untracked file and leaves ignored files out', () => {
    const root = repoWithOneCommit();
    writeFileSync(join(root, 'notes.txt'), 'untracked\n');
    writeFileSync(join(root, 'skip.log'), 'ignored\n');
    writeFileSync(join(root, '.gitignore'), 'skip.log\n');
    gitIn(root, ['add', '.gitignore']);
    gitIn(root, ['commit', '-q', '-m', 'chore: ignore logs']);
    const work = treeHashOfWorkingTree(root);
    expect(work).not.toBe(treeHashOfHead(root));
    const entries = execFileSync('git', ['ls-tree', '-r', '--name-only', work], {
      cwd: root,
      encoding: 'utf8',
    })
      .trim()
      .split('\n');
    expect(entries).toContain('notes.txt');
    expect(entries).not.toContain('skip.log');
  });

  it("does not disturb the repository index, so another agent's staged change survives", () => {
    const root = repoWithOneCommit();
    writeFileSync(join(root, 'staged.txt'), 'staged by another agent\n');
    gitIn(root, ['add', 'staged.txt']);
    const before = gitIn(root, ['diff', '--cached', '--name-only']);
    writeFileSync(join(root, 'a.txt'), 'dirty but never staged\n');
    treeHashOfWorkingTree(root);
    expect(gitIn(root, ['diff', '--cached', '--name-only'])).toBe(before);
  });

  /**
   * A stray untracked folder used to void a green run entirely: on 2026-11-20 the 0.17.205
   * CI pass was recorded over a tree that held two `smoke-1xx/` folders, no commit could ever
   * have that tree, and `check-push.mjs` refused the push for want of proof. The tracked tree
   * is the one a commit can reach, so it is the one a push is matched against.
   */
  it("leaves an untracked file out, so the tracked tree is still exactly HEAD's", () => {
    const root = repoWithOneCommit();
    writeFileSync(join(root, 'smoke-1'), 'untracked\n');
    const head = treeHashOfHead(root);
    expect(treeHashOfTrackedTree(root)).toBe(head);
    expect(treeHashOfWorkingTree(root)).not.toBe(head);
  });

  it('carries a tracked edit into the tracked tree, and an ignored file into neither', () => {
    const root = repoWithOneCommit();
    writeFileSync(join(root, '.gitignore'), 'scratch.log\n');
    gitIn(root, ['add', '.gitignore']);
    gitIn(root, ['commit', '-q', '-m', 'chore: ignore scratch']);
    writeFileSync(join(root, 'a.txt'), 'edited, still uncommitted\n');
    const head = treeHashOfHead(root);
    const work = treeHashOfWorkingTree(root);
    const tracked = treeHashOfTrackedTree(root);
    expect(tracked).not.toBe(head);
    // Nothing is untracked here, so both trees describe the same files.
    expect(tracked).toBe(work);
    expect(gitIn(root, ['cat-file', 'blob', `${tracked}:a.txt`])).toBe('edited, still uncommitted');
    writeFileSync(join(root, 'scratch.log'), 'ignored by both trees\n');
    expect(treeHashOfTrackedTree(root)).toBe(tracked);
    expect(treeHashOfWorkingTree(root)).toBe(work);
  });

  it('names an untracked folder once, as the folder and not as the files inside it', () => {
    const root = repoWithOneCommit();
    mkdirSync(join(root, 'smoke-1'));
    writeFileSync(join(root, 'smoke-1', 'prompt.md'), 'the laptop test prompt\n');
    writeFileSync(join(root, 'loose.txt'), 'untracked\n');
    expect(untrackedPaths(root)).toEqual(['loose.txt', 'smoke-1/']);
  });

  it("does not disturb the index, so another agent's staged change survives the tracked tree", () => {
    const root = repoWithOneCommit();
    writeFileSync(join(root, 'staged.txt'), 'staged by another agent\n');
    gitIn(root, ['add', 'staged.txt']);
    const before = gitIn(root, ['diff', '--cached', '--name-only']);
    writeFileSync(join(root, 'a.txt'), 'dirty but never staged\n');
    treeHashOfTrackedTree(root);
    expect(gitIn(root, ['diff', '--cached', '--name-only'])).toBe(before);
  });
});

/**
 * The suite takes minutes, and this worktree is shared, so the tree standing at the
 * end of a run is not necessarily the one the tests read. `ci-lock` hashes it when
 * it takes the lock and hands the hash down as `FORGE_CI_START_TREE`; the recorder
 * refuses to certify a tree that moved while CI ran.
 */
const recorder = join(__dirname, '..', '..', 'scripts', 'record-ci-pass.mjs');

/** Runs the recorder the way the `ci:steps` chain does: cwd is the repo, and the
 *  marker folder is the relative `.forge/ci-pass`, so it lands in the temp repo. */
function runRecorder(root: string, startTree?: string) {
  const env = { ...process.env } as Record<string, string | undefined>;
  delete env.FORGE_CI_START_TREE;
  if (startTree !== undefined) env.FORGE_CI_START_TREE = startTree;
  return spawnSync(process.execPath, [recorder], { cwd: root, encoding: 'utf8', env });
}

describe('the pass a finished run records, against the tree it started on', () => {
  it('is recorded when the tree at the end is the tree the run started on', () => {
    const root = repoWithOneCommit();
    const start = treeHashOfWorkingTree(root);
    const run = runRecorder(root, start);
    expect(run.status).toBe(0);
    expect(readMarker(join(root, '.forge', 'ci-pass'), start)).toMatchObject({ tree: start });
  });

  it('records nothing, and says so, when another lane edited while the suite ran', () => {
    const root = repoWithOneCommit();
    const start = treeHashOfWorkingTree(root);
    writeFileSync(join(root, 'a.txt'), 'edited while CI ran\n');
    const end = treeHashOfWorkingTree(root);
    expect(end).not.toBe(start);
    const run = runRecorder(root, start);
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe(
      `ci-pass: the working tree changed while CI ran (started at ${start.slice(0, 12)}, ` +
        `ended at ${end.slice(0, 12)}); no CI pass recorded.`,
    );
    const markerDir = join(root, '.forge', 'ci-pass');
    expect(existsSync(markerDir)).toBe(false);
    expect(readMarker(markerDir, end)).toBeUndefined();
    expect(readMarker(markerDir, start)).toBeUndefined();
  });

  it('is recorded from the tree at the end when no start tree was handed over', () => {
    const root = repoWithOneCommit();
    const head = treeHashOfHead(root);
    const run = runRecorder(root);
    expect(run.status).toBe(0);
    expect(readMarker(join(root, '.forge', 'ci-pass'), head)).toMatchObject({ tree: head });
  });

  it('marks the tracked tree too, naming what it left out, when an untracked folder is present', () => {
    const root = repoWithOneCommit();
    mkdirSync(join(root, 'smoke-1'));
    writeFileSync(join(root, 'smoke-1', 'prompt.md'), 'the laptop test prompt\n');
    const work = treeHashOfWorkingTree(root);
    const head = treeHashOfHead(root);
    expect(work).not.toBe(head);
    const run = runRecorder(root, work);
    expect(run.status).toBe(0);
    const markerDir = join(root, '.forge', 'ci-pass');
    expect(readMarker(markerDir, work)).toMatchObject({ tree: work });
    expect(readMarker(markerDir, head)).toMatchObject({ tree: head });
    expect(run.stdout.trimEnd().split(/\r?\n/)).toEqual([
      `ci-pass: also recorded tree ${head.slice(0, 12)}, the tracked files only ` +
        '(untracked left out: smoke-1/)',
      `ci-pass: recorded a green run for tree ${work.slice(0, 12)} (${work}.json)`,
    ]);
  });

  it('writes one marker and no extra line when the repo has nothing untracked', () => {
    const root = repoWithOneCommit();
    const head = treeHashOfHead(root);
    const run = runRecorder(root);
    expect(run.status).toBe(0);
    expect(readdirSync(join(root, '.forge', 'ci-pass'))).toEqual([`${head}.json`]);
    expect(run.stdout.trimEnd().split(/\r?\n/)).toEqual([
      `ci-pass: recorded a green run for tree ${head.slice(0, 12)} (${head}.json)`,
    ]);
  });
});
