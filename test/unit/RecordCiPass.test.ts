/**
 * The recorded green run (`scripts/record-ci-pass.mjs`) is the one thing the push gate cannot
 * check for itself, so it is the thing that used to be faked: `check-push.mjs --record-ci`
 * wrote the marker without running anything, and on 2026-11-12 a pass was recorded over a red
 * suite. The proof now comes from the run itself, which reaches the recorder only when every
 * step exited 0.
 *
 * These tests pin what makes that proof mean something: it names the tree the run actually
 * read (working tree, uncommitted edits included), a marker that cannot be read is never a
 * pass, and the directory stays bounded.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
  treeHashOfWorkingTree,
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
  it('is HEAD\'s tree exactly when nothing is uncommitted', () => {
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

  it('does not disturb the repository index, so another agent\'s staged change survives', () => {
    const root = repoWithOneCommit();
    writeFileSync(join(root, 'staged.txt'), 'staged by another agent\n');
    gitIn(root, ['add', 'staged.txt']);
    const before = gitIn(root, ['diff', '--cached', '--name-only']);
    writeFileSync(join(root, 'a.txt'), 'dirty but never staged\n');
    treeHashOfWorkingTree(root);
    expect(gitIn(root, ['diff', '--cached', '--name-only'])).toBe(before);
  });
});
