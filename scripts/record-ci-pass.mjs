/**
 * Records that the full CI steps just passed for the tree they tested, so the push gate has a
 * proof it did not have to trust an agent's word for.
 *
 * Before this, `check-push.mjs --record-ci` wrote the proof and never ran anything: on
 * 2026-11-12 a green pass was recorded over a red run, and the gate could not tell. The proof
 * now comes from the run itself — `npm run ci:steps` reaches this script only when every
 * earlier step exited 0, because the steps are chained with `&&`. A red suite leaves no marker.
 *
 * Markers are keyed by tree hash, and the hash is taken from the working tree, because that is
 * what the suite read: uncommitted edits included. So a run before a commit certifies the bytes
 * it tested, and it starts counting for a push the moment a commit has exactly that tree. Run
 * `npm run ci` after the commit it certifies to record it under HEAD's tree directly.
 *
 * The working tree holds files Git does not track at all, and one stray untracked folder makes
 * that hash a tree no commit can ever have: on the 0.17.205 release the green run certified a
 * tree that included two `smoke-1xx/` folders, `check-push.mjs` found no proof for it, and a
 * full CI run was wasted. So when the two differ the recorder marks the same green run a second
 * time, under the **tracked tree** — HEAD plus every edit to a tracked file, untracked files
 * left out — which is the tree a commit can actually reach.
 *
 * The risk this accepts: a tracked test that passes only because of an untracked file (a
 * fixture that was never committed, say) is not caught here. The GitHub CI run before the tag,
 * which checks out a clean clone, is what catches it.
 *
 * The suite takes minutes, and this worktree is shared, so the tree at the END is not the tree
 * the suite read. `scripts/ci-lock.mjs` therefore hashes the working tree the moment it takes the
 * lock and hands the hash down as `FORGE_CI_START_TREE`; if the tree moved while CI ran, this
 * script records nothing and says so. The suite passed — there is simply no proof to keep.
 */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MARKER_DIR = join('.forge', 'ci-pass');
/** How many green runs to keep. One marker per commit per agent would pile up forever. */
export const KEEP_MARKERS = 20;

export function markerName(treeHash) {
  return `${treeHash.trim()}.json`;
}

export function treeHashOfHead(cwd = process.cwd()) {
  return execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd, encoding: 'utf8' }).trim();
}

/**
 * Builds a tree from HEAD plus the working tree in a throw-away index under `os.tmpdir()`, so
 * the repository's real index — and therefore any other agent's staged changes — is untouched.
 * `addArgs` decides what joins HEAD: `-A` takes every file that is not ignored, `-u` only the
 * paths Git already tracks. Either way `write-tree` prints the tree those files describe.
 */
function treeHashWith(addArgs, cwd) {
  const index = join(tmpdir(), `forge-ci-pass-index-${process.pid}-${randomUUID()}`);
  const git = (args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_INDEX_FILE: index },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  try {
    git(['read-tree', 'HEAD']);
    git(['add', ...addArgs]);
    return git(['write-tree']).trim();
  } finally {
    try {
      unlinkSync(index);
    } catch {
      // Git never created the index, or something else already removed it: nothing to clean.
    }
  }
}

/**
 * The tree of the **working tree**, uncommitted edits included — which is what `npm run ci`
 * actually tested. `git add -A` skips ignored files, exactly as it does for a normal add, but
 * it does count untracked ones: see `treeHashOfTrackedTree` for the tree without them.
 */
export function treeHashOfWorkingTree(cwd = process.cwd()) {
  return treeHashWith(['-A'], cwd);
}

/**
 * The tree of the **tracked files only**: every edit to a tracked file is in it, and every
 * untracked file is out of it. That is the tree a commit of this working tree would have, so a
 * green run is worth recording under it when an untracked folder keeps the working tree's own
 * hash unreachable. Ignored files are out of both trees.
 */
export function treeHashOfTrackedTree(cwd = process.cwd()) {
  return treeHashWith(['-u'], cwd);
}

/**
 * The paths Git does not track, a whole untracked folder collapsed to `folder/`. These are the
 * files that make the working tree's hash unreachable for a commit, so the recorder names them
 * whenever it has to mark the tracked tree as well.
 */
export function untrackedPaths(cwd = process.cwd()) {
  const out = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--directory'], {
    cwd,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * Reads a marker for `treeHash`. Anything missing, unreadable, malformed, or written for a
 * different tree reads as absent — a half-written marker must never count as a pass.
 */
export function readMarker(dir, treeHash) {
  const file = join(dir, markerName(treeHash));
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && parsed.tree === treeHash ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Writes through a temporary name and renames, so a crash leaves `.writing`, never a partial marker. */
export function record({ dir, treeHash, at = new Date().toISOString(), steps = 'ci:steps' }) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, markerName(treeHash));
  const tmp = `${file}.writing`;
  writeFileSync(tmp, `${JSON.stringify({ tree: treeHash, at, steps })}\n`);
  renameSync(tmp, file);
  return file;
}

/**
 * Keeps the newest `keep` markers, by the `at` the recorder wrote; falls back to the file's
 * mtime when a marker was written by hand or its date cannot be parsed.
 */
export function prune(dir, keep = KEEP_MARKERS) {
  if (!existsSync(dir)) return [];
  const dated = [];
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.json'))) {
    const full = join(dir, name);
    let at;
    try {
      at = JSON.parse(readFileSync(full, 'utf8')).at;
    } catch {
      at = undefined;
    }
    let ms = at ? Date.parse(at) : Number.NaN;
    if (!Number.isFinite(ms)) {
      try {
        ms = statSync(full).mtimeMs;
      } catch {
        ms = 0;
      }
    }
    dated.push({ name, ms });
  }
  dated.sort((a, b) => b.ms - a.ms);
  const stale = dated.slice(Math.max(0, keep));
  for (const { name } of stale) {
    try {
      unlinkSync(join(dir, name));
    } catch {
      // Another window's marker vanished between the listing and the unlink: nothing to do.
    }
  }
  return stale.map((entry) => entry.name);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const startTree = process.env.FORGE_CI_START_TREE;
  const treeHash = treeHashOfWorkingTree();
  if (startTree !== undefined && startTree !== treeHash) {
    // Another lane edited while the suite ran, so the tree in front of this script
    // is not the one the tests read. Recording it would repeat, one step later, the
    // mistake this file exists to prevent — so nothing is recorded, and the exit
    // stays 0: a green suite is not undone by a proof it cannot write.
    console.log(
      `ci-pass: the working tree changed while CI ran (started at ${startTree.slice(0, 12)}, ` +
        `ended at ${treeHash.slice(0, 12)}); no CI pass recorded.`,
    );
    process.exit(0);
  }
  const headTree = treeHashOfHead();
  // Read the untracked list before writing anything: the recorder's own marker folder would
  // otherwise show up in it, and the list describes the tree the suite actually read.
  const untracked = untrackedPaths();
  const file = record({ dir: MARKER_DIR, treeHash });
  // The tree a commit of this working tree would have. When untracked files stand between the
  // two, the run is worth a marker under both: the working tree certifies these bytes, the
  // tracked tree is the one a commit — and so a push — can match.
  const trackedTree = treeHashOfTrackedTree();
  const proofTree = trackedTree === treeHash ? treeHash : trackedTree;
  if (trackedTree !== treeHash) {
    record({ dir: MARKER_DIR, treeHash: trackedTree });
    console.log(
      `ci-pass: also recorded tree ${trackedTree.slice(0, 12)}, the tracked files only ` +
        `(untracked left out: ${untracked.join(', ')})`,
    );
  }
  const removed = prune(MARKER_DIR);
  console.log(
    `ci-pass: recorded a green run for tree ${treeHash.slice(0, 12)} (${basename(file)})` +
      (removed.length
        ? `; pruned ${removed.length} older marker${removed.length === 1 ? '' : 's'}`
        : ''),
  );
  if (proofTree !== headTree) {
    console.log(
      `CI pass recorded for the working tree ${proofTree.slice(0, 12)}, which is not HEAD's tree. ` +
        'It counts for a push only once a commit has exactly this tree.',
    );
  }
}
