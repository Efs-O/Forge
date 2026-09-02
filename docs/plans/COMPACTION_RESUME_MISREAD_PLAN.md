# Compaction resume misread — plan (2026-09-03)

## The observed failure

Session `4fa3be7c-fe97-4b71-94ee-385f5af715fb`, generation 6 (`trigger: auto`,
`from_index: 467`, `summary_chars: 3211`). The agent had finished the work,
pasted the django re-run command into the terminal, and told the user to press
Enter. Auto-compaction fired. On the resumed turn the agent announced that the
run "errored again" — an event that never happened — and began re-investigating
a fix it had already shipped. The user stopped it.

The summary was **not** at fault. Recovered from workspaceState, generation 6
carries the correct root cause, the matplotlib PASS, and an exact Next:

> **Next:** User presses Enter on the pasted terminal command to re-run django
> (minimal arm) …

The ledger was not at fault either; it carried
`- pasted \`node scripts/forge-bench.mjs …\` into the terminal → outcome unknown
(never runs unattended)`.

What the agent actually latched onto is visible in its own reasoning:

> "So the user is saying it errored again. … So the django re-run errored again."

That sentence is a misreading of entry **[24]** in the `VERBATIM USER REQUESTS
AND DECISIONS` block — a request issued *before* the fix and already answered in
full.

## Why the block reads as a live instruction

`renderCompactionUserMessages` emits 24 numbered entries under a header that
says "later entries may refine earlier ones", inside a **user-role** message,
with no marker for which have been served. The newest entry therefore has every
surface property of a fresh instruction. It is not one: `collectCompactionUserMessages`
is only ever fed `split.summarize`, so by construction **every entry in the
block is history**. The header did not say so.

## The failure repeats

Scanned every session containing a resume prompt back to `48d34d8`
(2026-08-28, structured replacement context). Compaction rows themselves only
exist from `abd0ee1` (2026-09-02), so earlier generations were found via their
`RESUME_PROMPT` rows.

- **Re-anchoring on a stale `[N]` entry** — `517865bb` resume 724 ("User's last
  message [22] …" when [22] was not the last message), `79c22b03` resume 289
  ("according to the user's request [6]"). Both recovered within the same
  reasoning block; generation 6 above did not.
- **Re-verifying finished work** — `517865bb` resumes 113, 960, 1820;
  `79c22b03` resume 886. "Since the context was compacted, I should re-verify
  the work before declaring it complete." This is the failure `ba8582e` targeted
  and it is still present on 0.15.9.
- **Plan checkboxes contradicting the summary** — `517865bb` resumes 338, 1059.
  "The plan's checkboxes are stale relative to the actual state." Costs a couple
  of tool calls; both self-corrected. **Left alone** — see Not doing.

## Fixes

1. **`AgentLoop.ts:204` drops `options`.** The wiring adapter is written
   `(conv, text, attachments) => this.commitUserPrompt(conv, text, attachments)`
   against a 4-parameter signature. TypeScript accepts the narrower function, so
   `internal: true` — set correctly by both `compactionPolicy.ts:36` and
   `autoCompactionPolicy.ts:46` — has never reached `appendUserPrompt`. Confirmed
   against the live store: **0 of 472** persisted messages carry the flag, and
   `Continue the active task from the compacted context.` is sitting in the
   verbatim block as entry **[12]**, replayed to the model as user intent.

2. **Say that the verbatim block is history.** The entries are already-answered
   by construction; the header now states that, names the summary's State/Next
   as the authority on what is still open, and marks the final entry — the one
   that reads as live — explicitly.

3. **Preserve the last exchange verbatim.** `selectCompactionSplit` keeps the
   last user-started exchange only if it fits `RETAINED_TAIL_MAX_CHARS` (4000).
   Generation 6's last exchange cost **21,860 chars**, so the loop broke and
   `tailStart` stayed at `pending.length`: **zero verbatim tail**. The agent's own
   closing words — "Command is pasted — press Enter" — survived nowhere. Rather
   than raise the cap (it would have to more than quintuple to have helped here,
   on every compaction, to save one message), record the final user message and
   the final assistant text as a bounded host-authored block.

4. **Log the summary body.** `logCompaction` records `summary_chars: 3211` and
   drops the text. The one artifact that determines every following turn was
   unauditable from the session log; this analysis was only possible because the
   conversation was still live in workspaceState.

## Not doing

- **Raising `RETAINED_TAIL_MAX_CHARS`.** Fix 3 preserves what actually mattered
  at a bounded, predictable cost. A larger cap pays on every compaction for a
  benefit that is one message wide.
- **Plan/summary precedence wording.** Two occurrences, both self-corrected, and
  a prompt rule costs every turn (CLAUDE.md). Revisit if it recurs with a real
  cost attached.
- **Enforcement.** Everything here is host-recorded fact placed where the model
  reads it. No new refusals, no budget mechanics.
