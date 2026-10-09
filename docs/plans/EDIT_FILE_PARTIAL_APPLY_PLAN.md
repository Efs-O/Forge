# edit_file: apply what matches, and accept a uniform indent shift

Decided by the user on 2026-10-09, during the forge-bench follow-up reruns.

## Why

`edit_file` batches are all-or-nothing today: one `old_str` that misses discards every edit in the call, and the
model regenerates the whole batch. Measured on the last 3 days of `~/.forge/sessions` (rows deduplicated):

- 526 `edit_file` results, 66 misses (12.5%).
- 52 of the 66 misses were inside multi-edit batches. Those forced **253 edits that had matched** to be generated
  again, about 5 per miss.
- A case the user saw live: a 4-edit batch was discarded because one `old_str` line had 4 spaces where the file
  had 2, and the model had to resend all 4.

On a local model every regenerated token is decode time, and every extra round re-reads the prompt. The batch form
exists to save rounds (see `parseEdits` in `src/tools/editFileTool.ts`); all-or-nothing gives the cost of a lost
batch back on every miss.

## Changes

### 1. Partial apply

- Edits still apply in order, each against the text the earlier ones left.
- An edit whose `old_str` is not found is skipped and reported; the others are applied.
- An edit that depends on text a skipped edit would have created misses too and is reported the same way, so
  nothing is applied out of order without the model being told.
- No edit matched: nothing is written and the call fails as today (same diagnosis text).
- Some matched: the file is written once, and the result starts with `Partly applied:` and names the applied and
  the missed edits by number. It gives the full miss diagnosis (`describeEditMiss`) for the first 3 misses and the
  numbers only for the rest, and says to resend only the missed edits because the applied ones are already in the
  file.
- The 200-edit cap is unchanged: a call over the cap is still refused whole (user decision, finding 17).
- `describeOtherEdits` goes: its job (telling the model which edits would have matched) is now done by applying
  them.

### 2. Indent-shift fallback

When the exact (line-ending-insensitive) match fails, `edit_file` tries one more match, and applies it only when all
of these hold:

- `old_str`'s lines match exactly one block of whole lines in the file once leading whitespace is ignored (zero or
  several blocks: a miss).
- Every leading whitespace in that block, in `old_str` and in `new_str` uses one character only, all spaces or all
  tabs, the same one.
- Every non-blank line of the block differs from `old_str` by the same count (the shift).
- `new_str` can take the same shift: when the shift removes indentation, every non-blank `new_str` line has at
  least that much.

Then `new_str` is shifted by the same count and spliced in. Relative nesting inside `new_str` is kept, so a nesting
change the model meant to make survives, and the block lands at the file's own level. The result says
`indentation adjusted` and names the line.

This reverses the earlier rule in `editMatch.ts` ("reported, never auto-applied"). That rule guarded against a
silent re-indent changing what a Python or YAML edit means. Here the shift is one uniform count, the match is
unique, and the result says so; a mixed or non-uniform case stays a miss with the existing diagnosis.

### 3. Text

- `edit_file`'s description: drop "all-or-nothing", say a missed edit is skipped and reported while the others
  apply, and that a uniform indentation difference is adjusted.
- CHANGES.md 0.17.0 entry.

## Files

- `src/tools/editMatch.ts`: `findIndentShiftedMatch` (owner of matching, as today).
- `src/tools/editFileTool.ts`: the apply loop, the result text, the description.
- `test/unit/editMatch.test.ts`, `test/unit/EditFileTool.test.ts`.

## State × lifecycle ledger

No durable state. The tool writes the user's file once per call, as it does today; it creates no file, entry or
record of its own.

## Acceptance criteria

- A 4-edit batch with one miss writes the other 3, and the result names edit 2 as missed with its diagnosis.
- A batch where every edit misses writes nothing and fails as before.
- An edit that depends on a missed earlier edit is reported missed as well.
- An `old_str` with 4 spaces against a 2-space block applies, `new_str` is shifted by −2, and the result says
  indentation adjusted.
- Python case: a block whose lines shift by different amounts is a miss, not applied.
- Two blocks that both match ignoring indentation: a miss.
- Tabs in the file and spaces in `old_str`: a miss.
- A removing shift that `new_str` cannot take (a line with less indentation than the shift): a miss.
- CRLF file: the shifted splice keeps CRLF.
- `npm run ci` and `npm run package` green; then the remaining follow-up reruns run on this build and the session
  audit counts resent edits and indent adjustments.
