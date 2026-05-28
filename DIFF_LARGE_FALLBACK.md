# Large-File Diff Fallback

## Problem

`DiffUtils.computeDiff` uses an O(m×n) LCS algorithm and bails out with `null`
when either file exceeds **500 lines**. The webview then renders:

> File too large to diff inline.

This is a hard wall — no diff at all for any file ≥ 500 lines.

## Root Cause

The LCS DP table for a 2000-line file would be ~16 MB and take ~200 ms. The cap
was set conservatively to prevent extension-host jank.

## How Claude Code Solves It

Claude Code shells out to **`git diff --no-index`** for file comparisons.
Git's patience/histogram algorithm is O(N + D²) in the edit distance D — it
stays fast even on large files. No in-process memory spike.

## Fix

### 1. `DiffUtils.ts` — add `parseUnifiedDiff`

Pure parser: converts `git diff --unified=3` stdout into `DiffHunk[]`.
No new imports, no Node.js side-effects.

### 2. `ToolDispatch.ts` — add `gitDiffLarge` + wire fallback

When `computeDiff` returns `null`:
1. Write `beforeContent` and `afterContent` to two OS temp files.
2. Run `git diff --no-index --unified=3 -- <before.tmp> <after.tmp>` via
   `spawnSync` (no shell, no injection risk).
3. Parse stdout with `parseUnifiedDiff`.
4. Clean up temp files in `finally`.
5. If git itself fails (not on PATH, etc.) fall back to `null` — existing
   "File too large" message still shows.

### 3. `Message.tsx` — message tweak

Change "File too large to diff inline." → "Diff unavailable." so the message
stays accurate on the rare git-failure path.

## Checklist

- [x] `parseUnifiedDiff` added to `DiffUtils.ts`
- [x] `gitDiffLarge` added to `ToolDispatch.ts`
- [x] `postFileDiff` wired to call fallback
- [x] `Message.tsx` message updated ("Diff unavailable." for git-failure edge case)
- [x] `npx tsc --noEmit` passes (clean)
