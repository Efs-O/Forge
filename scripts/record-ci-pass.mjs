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
 * The tree of the **working tree**, uncommitted edits included — which is what `npm run ci`
 * actually tested. Builds it in a throw-away index under `os.tmpdir()` so the repository's real
 * index, and therefore any other agent's staged changes, are untouched. `git add -A` skips
 * ignored files, exactly as it does for a normal add.
 */
export function treeHashOfWorkingTree(cwd = process.cwd()) {
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
    git(['add', '-A']);
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
  const headTree = treeHashOfHead();
  const treeHash = treeHashOfWorkingTree();
  const file = record({ dir: MARKER_DIR, treeHash });
  const removed = prune(MARKER_DIR);
  console.log(
    `ci-pass: recorded a green run for tree ${treeHash.slice(0, 12)} (${basename(file)})` +
      (removed.length ? `; pruned ${removed.length} older marker${removed.length === 1 ? '' : 's'}` : ''),
  );
  if (treeHash !== headTree) {
    console.log(
      `CI pass recorded for the working tree ${treeHash.slice(0, 12)}, which is not HEAD's tree. ` +
        'It counts for a push only once a commit has exactly this tree.',
    );
  }
}
