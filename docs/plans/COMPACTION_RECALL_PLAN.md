# Compaction recall: reach the text before the cut

Status: approved by the user 2026-10-01, implementer Copilot (Forge's owned
Copilot session), reviewer Claude.

## Problem

Compaction does not delete anything. `/compact` and autocompact record a
summary plus a cut point (`compactionWindow.ts`), and only the request sent to
the model is cut. The full chat stays in `conv.messages`, in the persisted
conversation (`slimPersistMessages` keeps full tool-result text), and in the
session log.

Tools already receive that full chat: `ModelTurn.ts:266` passes `conv.messages`
and `ToolDispatch.ts:245` hands it to every tool as `conversationMessages`. So
`read_tool_result` can already fetch a result from before the cut. In practice
it never does, because it needs a `tool_call_id` and nothing after the cut
carries one.

### Evidence (audit of `~/.forge/sessions/*.jsonl`, 2026-10-01)

Rows were deduplicated first, minus `timestamp_ms`. The audit found 157
compactions and examined the next 40 tool calls after each.

| Signal | Count |
|---|---|
| Agent says it lacks something from before the cut ("I no longer have the exact edit list", "I don't have the exact timestamps") | 32 of 157 compactions (20%); a regex floor |
| Identical read-only call repeated after the cut | 111 of 157; 550 of 5,237 calls. Mostly legitimate re-reads before an edit |
| `read_tool_result` calls after a cut | 10 in total |
| HalluScribe or raw-session searches after a cut | 2 in total |

The missing things fall into two kinds:

1. **An exact earlier tool result:** an edit list, line ranges, fetched
   comment timestamps, a staged diff.
2. **Earlier chat text:** an assistant's ranked list that the user then
   answered with "2", or how something was done earlier.

Kind 1 needs an ID or a search. Kind 2 needs a search, because chat text has no
tool ID.

## Design

Two changes. Neither adds a tool, so the tool count and tool names stay the
same.

### Phase 1: tool-call IDs in the recorded-actions ledger

`RecordedCompactionAction` (`compactionTypes.ts`) gains an optional
`toolCallId?: string`.

- **Where IDs come from.** `collectWriteActions` and `collectCommandActions` in
  `compactionLedger.ts` already hold `call.id` when they build each action
  (`results.get(call.id)`). Store it on the action.
- **How they render.** `renderRecordedActionsBlock` appends ` (id <toolCallId>)`
  to the entry's line at render time. Do not bake it into `line`, so the
  persisted `line` stays unchanged and the existing line-length cap still
  holds.
- **Schema.** `compactionPersistedSchema.ts` gets
  `toolCallId: z.string().min(1).max(128).optional()` inside the `.strict()`
  object.
- **Merging across generations.** When merging and capping (`capActions` and
  the generation merge), an action that replaces an older one with the same
  `key` carries the newer action's `toolCallId`.
- **One line in the ledger header.** It tells the agent that an id can be passed
  to `read_tool_result` to read that call's exact output. Keep it to one
  sentence.

These IDs are written by Forge, never by the summarizer model. A model-copied
ID can be wrong, and a wrong ID is worse than none.

### Phase 2: a search mode on `read_tool_result`

`toolResultTools.ts` keeps its current mode and gains two more. Exactly one
mode per call:

| Mode | Args | Returns |
|---|---|---|
| exact tool result (existing) | `tool_call_id`, optional `offset`, `max_chars` | unchanged |
| **search (new)** | `query` (string, 2-200 chars), optional `max_matches` (1-10, default 6) | matching excerpts, newest first |
| **exact message (new)** | `message_index` (integer ≥ 0), optional `offset`, `max_chars` | a bounded range of that user or assistant message's text |

Search rules:

- **Matching.** Literal, case-insensitive substring match. No regex, so there
  is no pathological pattern to guard against.
- **Scope.** It searches `user`, `assistant` (`content` only, not `reasoning`)
  and `tool` messages in `conversationMessages`, including those before the
  compaction cut. Messages flagged `internal` are skipped. A non-string
  `content` is searched through its text parts only.
- **Hit format.** Each hit is one line of header plus an excerpt of about 300
  characters centred on the match. The header gives the role and the
  `message_index`, plus `tool_call_id` for tool rows. It also gives the hit's
  character offset, so the exact modes can page from there.
- **Output cap.** Total output stays at or under `MAX_TOOL_RESULT_READ_CHARS`
  (6,000). If more matches exist than are shown, say how many and suggest a
  narrower query.
- **No matches.** The result says so and names the two exact modes. A bare
  "no matches" is not acceptable (see CLAUDE.md, "Refusals must name the
  sanctioned alternative").
- **Validation.** It happens in the handler, because the strict JSON schema
  lists every property as optional with `additionalProperties: false`.
  - Zero modes, or more than one: return an error naming the three modes.
  - `query` shorter than 2 characters: error.
  - `message_index` out of range or pointing at a `tool` row: error. For a
    `tool` row, say to use its `tool_call_id`.
- **Description.** It changes to say the tool can search and read anything
  earlier in this conversation, including before a compaction. The schema
  description is bounded, and the total description plus schema may grow by
  at most **600 characters**. Measure this with `JSON.stringify(definition)`
  before and after, and report both numbers.

The name stays `read_tool_result`, which keeps the cached tool list stable. The
user accepted the name mismatch over adding a tool.

### Phase 2b: one sentence in the resume context

`SUMMARY_PREAMBLE` in `compactionWindow.ts` gains one sentence. It says that
the earlier conversation is still stored, and that `read_tool_result` with
`query` searches it. Keep it to one sentence: this text is sent on every turn
after a compaction.

## Files

| File | Change | Lines now |
|---|---|---|
| `src/sidebar/compactionTypes.ts` | `toolCallId?` on the action type | 59 |
| `src/sidebar/compactionPersistedSchema.ts` | the optional field | 72 |
| `src/sidebar/compactionLedger.ts` | store `call.id` on actions | 458 (do not pass 500; extract a helper if needed) |
| `src/sidebar/compactionRecordedState.ts` | render the id, carry it through merging, one header line | 155 |
| `src/tools/toolResultTools.ts` | search and message modes | 68 |
| `src/sidebar/compactionWindow.ts` | one preamble sentence | 163 |
| `test/unit/…` | see the acceptance criteria | |
| `CHANGES.md` | one entry under the top version section | |

Re-measure the line counts before starting. Another change may have landed
since.

## Execution rules for this run

- Implement Phase 1, then Phase 2 and 2b, in that order, all in the main
  working tree.
- **Do not commit.** Claude reviews and commits.
- Do not edit `.forge/config.yaml`, `FORGE.md`, `CLAUDE.md` or `AGENTS.md`.
- `.ts`/`.tsx` files have a 500-line hard limit (eslint `max-lines`), with a
  soft threshold at 350.
- After the last edit, run the full CI with Git's bin directory first on PATH,
  and read only the tail:
  `PATH="/c/Program Files/Git/bin:$PATH" npm run ci 2>&1 | tail -n 40`.
  If a test fails, rerun only that test file for detail, then rerun the full
  CI.
  - Running only tsc and vitest is not enough.
  - Fix prettier errors with `npx eslint --fix <src file>`. Do not run eslint
    on test files directly, because they are not in the lint tsconfig.
- Finish with:
  - the CI result (the pass counts, or the failing test);
  - `git status --short`;
  - the tool-definition size before and after;
  - one line per acceptance criterion with how it was verified.

## Known limitations

- Search covers the current conversation only. Other chats and archived chats
  stay reachable through HalluScribe or the session logs, as today.
- After `/clearChat` the history is gone, and so is the ledger that pointed
  into it. This is consistent.
- `reasoning` is not searched. It is long, is the model's own scratch work, and
  a match there would mostly echo the query back.
- A search cannot tell "never said" from "said with different wording". The
  no-match message says so.

## State × lifecycle ledger

The search mode writes nothing. The only durable artifact is the new optional
field.

| Artifact | Create | Delete | Pause/disable | Crash mid-write | Owner-process death | TTL/expiry |
|---|---|---|---|---|---|---|
| `compaction.recordedActions[].toolCallId` in the persisted conversation | Written when a compaction records an action whose tool call had an id. Absent on older records, which still parse because the field is optional | Removed with the conversation (`/clearChat`, deletion), or when the action is capped out of the ledger. A later compaction generation replaces it with the newer action's id | Not applicable: no setting turns the ledger off. If a later change adds one, this row must be revisited | Covered by the persisted conversation's existing write path; the field adds no new write. A torn write fails the whole record's schema check, as today | The id points at a message in the same persisted conversation, so it survives a reload with the record. It is not tied to any process | None of its own. It lives as long as its conversation. **Downgrade:** an older Forge build's `.strict()` schema rejects the unknown field. The release note must say a downgrade drops compaction records written by this version |

**CI-enforced row (cheapest):** a unit test in which a compaction state
**with** `toolCallId` round-trips through the persisted schema, and one
**without** it still parses. In the same test, every id rendered by
`renderRecordedActionsBlock` for a fixture conversation must resolve through
`read_tool_result` against that conversation's messages. That pins the
invariant "every id the ledger prints is readable".

## Acceptance criteria

1. **IDs in the ledger.** A compaction of a fixture conversation with one write
   and one command renders both ledger entries with ` (id <id>)`. Each id
   resolves through `read_tool_result({tool_call_id})` to that call's result.
2. **Old records still load.** A persisted compaction state without
   `toolCallId` parses and renders exactly as before, checked against a snapshot
   of the current output.
3. **Merging keeps the newest id.** Across two generations with the same action
   key, the newer id is kept.
4. **Search finds text from before the cut, in all three roles.** On a fixture
   whose first half lies before the compaction `fromIndex`:
   - a user message, an assistant message and a tool result before the cut are
     each found by `query`;
   - each hit carries the right `message_index`, and `tool_call_id` for tool
     rows;
   - results are newest first.
5. **Exact-message mode.** `message_index` reads a bounded range of a
   user or assistant message. On a tool row it returns an error naming
   `tool_call_id`.
6. **Validation errors.** Zero modes, two modes, a 1-character query and an
   out-of-range index each return a specific error that names the valid modes.
7. **Output cap.** Search output stays at or under 6,000 characters with 50
   matching messages, and reports how many matches were not shown.
8. **The no-match message** names both exact modes.
9. **Text excluded from search.** Neither `reasoning` text nor an `internal`
   message is ever returned by search.
10. **Definition size.** The tool definition grows by at most 600 characters.
    Report the numbers.
11. **Preamble.** `SUMMARY_PREAMBLE` gains exactly one sentence that mentions
    `read_tool_result` and `query`.
12. **CI.** `npm run ci` passes. No `.ts` file passes 500 lines.
13. **CHANGES.md** has the entry, and it includes the downgrade note.
