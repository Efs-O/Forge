export type DiffLineKind = 'context' | 'added' | 'removed';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

const CONTEXT_SIZE = 3;
export const MAX_LINES = 500;

/**
 * Compute a structured line-level diff between two strings.
 * Returns null when either input exceeds MAX_LINES (too large to diff inline).
 * Returns an empty array when the files are identical.
 */
export function computeDiff(before: string, after: string): DiffHunk[] | null {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');

  if (a.length > MAX_LINES || b.length > MAX_LINES) return null;

  const m = a.length;
  const n = b.length;

  // LCS DP table (reverse fill so we can backtrack forward)
  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // Backtrack to produce a flat edit list
  type Edit = { kind: 'eq' | 'add' | 'del'; ai: number; bi: number; text: string };
  const edits: Edit[] = [];
  let i = 0,
    j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) {
      edits.push({ kind: 'eq', ai: i, bi: j, text: a[i] });
      i++;
      j++;
    } else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) {
      edits.push({ kind: 'add', ai: i, bi: j, text: b[j] });
      j++;
    } else {
      edits.push({ kind: 'del', ai: i, bi: j, text: a[i] });
      i++;
    }
  }

  // Mark which edit indices belong in a hunk (changed line ± CONTEXT_SIZE)
  const inHunk = new Uint8Array(edits.length);
  for (let k = 0; k < edits.length; k++) {
    if (edits[k].kind !== 'eq') {
      const lo = Math.max(0, k - CONTEXT_SIZE);
      const hi = Math.min(edits.length - 1, k + CONTEXT_SIZE);
      for (let c = lo; c <= hi; c++) inHunk[c] = 1;
    }
  }

  // Collect contiguous marked runs into hunks
  const hunks: DiffHunk[] = [];
  let k = 0;
  while (k < edits.length) {
    if (!inHunk[k]) {
      k++;
      continue;
    }
    const start = k;
    while (k < edits.length && inHunk[k]) k++;
    const chunk = edits.slice(start, k);
    hunks.push({
      oldStart: chunk[0].ai + 1,
      newStart: chunk[0].bi + 1,
      lines: chunk.map((e) => ({
        kind: e.kind === 'eq' ? 'context' : e.kind === 'add' ? 'added' : 'removed',
        text: e.text,
      })),
    });
  }
  return hunks;
}

/**
 * Parse the stdout of `git diff --no-index --unified=N` into DiffHunk[].
 * Returns an empty array when the patch is empty (files identical).
 */
export function parseUnifiedDiff(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  if (!patch.trim()) return hunks;

  let hunk: DiffHunk | null = null;
  for (const line of patch.split('\n')) {
    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      if (hunk) hunks.push(hunk);
      hunk = { oldStart: parseInt(header[1], 10), newStart: parseInt(header[2], 10), lines: [] };
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      hunk.lines.push({ kind: 'added', text: line.slice(1) });
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      hunk.lines.push({ kind: 'removed', text: line.slice(1) });
    } else if (line.startsWith(' ')) {
      hunk.lines.push({ kind: 'context', text: line.slice(1) });
    }
  }
  if (hunk) hunks.push(hunk);
  return hunks;
}
