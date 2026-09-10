# Delete/Restore Gap Plan

Diagnosed from session `3510c96c-a888-4877-96d2-847060f66607.jsonl`
(qwen38-27b-mtp-ud-q4kxl, Forge 0.15.34, 2026-09-10 21:39–22:11).

## What actually happened

Rows 104–125, in order:

1. Row 104 — `query_powershell get_file_hash` on `CHANGELOG.md` and on
   `CHANGES.md`. Identical SHA256 (`34E044BC…`).
2. Row 108 — `delete_file {"path": "CHANGES.md"}`. Result:
   `Moved to recycle bin: CHANGES.md`.
3. Row 121 — `stage {"paths": ["CHANGES.md", "test/unit/execTools.test.ts"]}`.
   Result: `Staged: CHANGES.md, test/unit/execTools.test.ts`.
4. Row 124 — `commit` with the message
   `Fix flaky execTools test; remove duplicate CHANGES.md`.
5. Rows 131/137 — `npm run package` fails twice: `scripts/sync-changelog.mjs`
   generates `CHANGELOG.md` **from** `CHANGES.md`, which no longer exists.
6. Row 141 — reads `.gitignore` and finds, verbatim:
   `# Generated from CHANGES.md at package time; CHANGES.md is the real one.`
   followed by `/CHANGELOG.md`.
7. Row 142 — `git ls-files --error-unmatch CHANGES.md` → *did not match* (it
   had already committed the deletion, so this reads as confirmation of the
   wrong conclusion).
8. Row 143 — `git checkout HEAD~1 -- CHANGES.md` → **refused by the denylist**,
   whose alternative text names `switch_branch` and `git_show`, neither of
   which can restore a file.
9. Row 148 — the user has to intervene: *"can you just rename the file man? if
   you cant i will restore it from the recycle bin"*.
10. Row 151 — `move_file CHANGELOG.md → CHANGES.md` recovers it (byte-identical,
    so this was exact) and row 161 amends the commit — via `exec_command`,
    because the `commit` tool has no amend.

The PowerShell calls were three `get_file_hash` reads. Harmless, and correct
for what they measured. The inference drawn from them was the whole failure:
**identical content was read as evidence of duplication, with no check of which
file generates which.**

## The five gaps

| # | Gap | Evidence |
|---|---|---|
| A | Nothing at delete time says the path is **tracked in git** | Row 108 deletes a committed source-of-truth file; the approval dialog (`describeDelete`) showed size and scope only |
| B | **No restore tool.** `git checkout <ref> -- <path>` is denylisted and the refusal names two tools that cannot restore | Rows 143–144 |
| C | **No recycle-bin restore.** `delete_file` advertises the bin as the safety net and offers no way back out | Row 148 — the user offers to do it by hand |
| D | **`commit` has no `amend`** | Row 161 shells out to `git commit --amend` |
| E | **`stage` hides the kind of change it staged** | Row 122 says `Staged: CHANGES.md` for what is a *deletion* |

Note what the checkpoint system would have done: `delete_file` declares
`mutation: { paths, showDiff: true }`, `CheckpointInventory` snapshots the
original entry, and `restoreDiskCheckpoint` recreates deleted files. **`/undo`
on that turn would have restored `CHANGES.md` immediately.** The agent never
knew that, because nothing in the tool result says so.

## Fixes

### A. Tracking status at the moment of deletion — *the load-bearing fix*

New owner file `src/tools/gitTrackedStatus.ts`:

```ts
type TrackedState = 'tracked' | 'untracked' | 'ignored' | 'not-a-repo';
export async function describeTrackedState(absPath: string): Promise<TrackedState>
```

Uses `gitCwd()` (per the nested-repo rule in CLAUDE.md), `git ls-files
--error-unmatch` then `git check-ignore -q`. Two consumers:

1. `delete_file`'s **result string** — the CLAUDE.md doctrine that guidance
   belongs in the return string, where it costs nothing on the turns it is not
   needed:

   ```
   Moved to recycle bin: CHANGES.md
   This file was tracked in git at HEAD. If that was not intended, restore it
   with restore_file({"path":"CHANGES.md"}), or /undo this turn.
   ```

2. `describeDelete()` in `src/sidebar/ToolDispatch.ts` — one extra line,
   `Git: tracked at HEAD` / `untracked` / `ignored`. This is the human's last
   line of defence and it withheld the single fact that mattered.

No refusal, no extra round. The fact arrives where the decision is made.

### B. `restore_file` tool

In `src/tools/gitTools.ts`. `permission: 'write'`, with
`mutation: { paths, showDiff: true }` so it is itself checkpointed. Runs
`git checkout <ref> -- <paths>` through `runGit` (tools are not denylisted;
the write-confirmation gate still applies). `ref` defaults to `HEAD`.

Then rewrite the `isDestructiveGitCheckout` entry's `alternative` in
`src/tools/DenyList.ts` to name `restore_file`. Today's text points at
`switch_branch` and `git_show` — the exact "refusal that does not name a
sanctioned alternative" trap CLAUDE.md documents, which is what sent the agent
to the user instead of to a tool.

### C. `restore_from_trash` tool

Windows-only, contained in a new `src/tools/trashRestore.ts`, driven by
`Shell.Application` COM (`NameSpace(0xA)` → match by original path →
`InvokeVerb('Restore')`). On any other platform it throws a plain message
naming `restore_file` and `/undo` instead. Optional argument — say the word if
you would rather not carry a COM dependency; A + B + `/undo` already cover the
tracked case, and C only covers the untracked one.

### D. `commit` gains `amend: boolean`

- Skips the "nothing is staged" throw (a message-only amend is legitimate).
- Refuses when `git branch -r --contains HEAD` is non-empty — amending a commit
  that is already on a remote is history rewriting on published work, which is
  the user's call.

### E. `stage` reports what it staged

`readLiveGitStatus` already carries the index letter. Render it:
`Staged: CHANGES.md (deleted), test/unit/execTools.test.ts (modified)`.
Free — the data is in hand and currently discarded.

## Deliberately *not* doing

A `FORGE.md` rule saying "check tracking before you delete". CLAUDE.md is
explicit that a prompt rule costs every turn and dilutes the rules that work.
A and E put the same fact in the tool result, where it costs nothing on the
turns it is irrelevant. If A ships and the failure recurs, revisit.

## Verification

- Unit: `describeTrackedState` over tracked / untracked / ignored / non-repo.
- Unit: `restore_file` restores a deleted tracked file from `HEAD`.
- Unit: `commit` with `amend` refuses on a pushed HEAD, succeeds otherwise.
- Unit: `stage` renders the change kind.
- Regression: the exact sequence — delete a tracked file, read the result
  string, restore from it.
- `npm run ci` and `npm run package`.

## Owners rows to add

| Git tracked-state probe | `src/tools/gitTrackedStatus.ts` |
| Recycle-bin restore     | `src/tools/trashRestore.ts`      |
