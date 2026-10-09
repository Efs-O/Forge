# Follow-up fixes from the 2026-10-09 bench reruns

Three small fixes found by auditing the pelican-joust and jelly-press rerun
session logs. Approved by the user on 2026-10-09. They ship in a new build that
is installed before the uncapped bench runs, never into a run already in
progress.

## 1. Compaction keeps the first request in its own allowance

**Found:** the jelly-press task prompt was 5,710 characters. Compaction keeps
user messages verbatim, but every message was cut at
`USER_CONTEXT_MESSAGE_MAX_CHARS` (4,000), so the last third of the spec was lost
after the first compaction: UI, sound, quality bar, and "do not open a browser".

**Change:** the first request is truncated at `FIRST_REQUEST_MAX_CHARS`
(12,000) instead of 4,000, and does not count against `USER_CONTEXT_MAX_CHARS`.
Later messages keep their full 12,000 (the user's condition: the first request
must not take room from the others).

The extra characters (first request length minus 4,000) are added to **both**
`hostMaxChars` and `replacementMaxChars` by `withFirstRequestAllowance` in
`compactionBudget.ts`. The summary allowance is
`min(summaryCeiling, replacementMax - floor)`, so growing both by the same
amount leaves the summary, the recorded actions and the later requests exactly
as large as before. The render default and the roomy-window path in
`fitUserMessagesToHostBudget` grow by the same amount.

A conversation compacted on an older build already holds a 4,000-character
first request; this fix cannot restore the cut text there.

## 2. `edit_file` warns when an edit joins two lines

**Found:** jelly-press call 61 replaced text ending in a line break with text
that did not, joining lines 316 and 317. The model found it 45 minutes later.

**Change:** after each applied edit, if the replaced text began or ended with a
line break that the replacement dropped, and text sits on both sides of the
seam, the result carries a warning naming the line (and the edit number in a
batch). Whole-line deletions do not warn. The edit is still written: joining
lines can be intended.

## 3. `apply_line_edits` count error names both counts and the range

**Found:** "expected_lines must contain 3 lines" left the model to work out how
many it sent and which span it meant.

**Change:** the error now says `expected_lines has N line(s), but lines S-E are
M line(s)` and what `expected_lines` must be.

## State × lifecycle ledger

No durable state. Fix 1 changes how a compaction record is built, but the
record itself (its fields, where it is stored, when it is replaced) is
unchanged; fixes 2 and 3 change tool result strings only.

## Acceptance criteria

- A first request of up to 12,000 characters survives compaction whole; a
  longer one is cut at 12,000.
- With a 12,000-character first request, the later messages kept are identical
  to those kept with a short first request (`CompactionUserContext.test.ts`).
- `withFirstRequestAllowance` grows `hostMaxChars` and `replacementMaxChars` by
  the same amount and leaves the summary allowance unchanged (same test file).
- `edit_file` warns on a dropped trailing or leading line break, names the edit
  in a batch, and stays quiet for whole-line deletions and line-preserving
  edits, CRLF included (`EditFileTool.test.ts`).
- The `apply_line_edits` count error states both counts and the range
  (`StructuredEditTool.test.ts`).
- `npm run ci` and `npm run package` pass.
