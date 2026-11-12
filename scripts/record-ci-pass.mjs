/**
 * Records that the full CI steps just passed for the tree at HEAD, so the push gate has a
 * proof it did not have to trust an agent's word for.
 *
 * Before this, `check-push.mjs --record-ci` wrote the proof and never ran anything: on
 * 2026-11-12 a green pass was recorded over a red run, and the gate could not tell. The proof
 * now comes from the run itself — `npm run ci:steps` reaches this script only when every
 * earlier step exited 0, because the steps are chained with `&&`. A red suite leaves no marker.
 *
 * Markers are keyed by tree hash, so the run has to happen **after** the commit it certifies:
 * commit, then `npm run ci`, then push. A suite run before the commit certifies a tree that is
 * no longer the tip.
 */
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
  const treeHash = treeHashOfHead();
  const file = record({ dir: MARKER_DIR, treeHash });
  const removed = prune(MARKER_DIR);
  console.log(
    `ci-pass: recorded a green run for tree ${treeHash.slice(0, 12)} (${basename(file)})` +
      (removed.length ? `; pruned ${removed.length} older marker${removed.length === 1 ? '' : 's'}` : ''),
  );
}
