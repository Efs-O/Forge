# Activity view declutter + live tool-call progress (2026-10-09)

Owner feedback from a phone screenshot of the jelly-press bench run: the activity
list is still too noisy, and a long `write_file` leaves the screen frozen for minutes
because nothing streams while the model writes tool-call arguments.

Decisions taken with the owner before this plan:

- Drop **any** leading `cd <dir> &&` from the shell row label.
- **Fold** runs of consecutive same-tool calls into one row.
- Progress row shows **tool + target + token count**, and the thinking bubble gets a
  **ticking timer**. No tokens/s, not for every tool call.
- The ✓ on every row **stays**.
- Split: **Codex** builds the host side (items 4 and 6, host half); **Claude** builds
  the webview side and reviews Codex's diff.

## 1. Shell label: the command arrives quoted (webview + host, Claude)

`extractToolDetail` (`src/sidebar/toolSummary.ts`) runs `displayArgument` over
`[command, ...args]`, and `displayArgument` JSON-quotes any value containing
whitespace. A shell `command` is a whole command line, so it always has spaces and
always arrives as `"cd \"n:/vs code apps/…\" && grep …"`. `displayDetail`
(`webview-ui/src/activityRows.ts`) already strips `^cd … &&`, but it never matches
because the string starts with `"`.

Fix: never quote `command`. Only `args[]` entries keep quoting. `displayDetail` then
strips the prefix as designed. Make it handle a quoted `cd "dir with spaces" &&` and
chained `cd a && cd b &&`. The expanded `ToolRow` keeps the full command.

## 2. Fold runs of the same tool (webview, Claude)

In `toCompactRows` / the step builder (`webview-ui/src/activityRows.ts`), merge
consecutive steps when all of these hold:

- they have the same `toolName`;
- none of them has a diff;
- none ended in failure;
- no message row comes between them.

The folded header reads `shell ×4 · grep, sed` for shell (the distinct first words
after the `cd` strip, at most three, then `…`). For other tools it reads
`read_file ×3 · jelly-press.html, style.css`. Expanding it lists the original step
rows, unchanged. Exact-repeat merging (`×2` on the same target) keeps working inside
a run.

A failed step, or a step with a diff, breaks the run. Edits and failures must stay
visible at a glance.

## 3. Expanded single step repeats its header (webview, Claude)

When a step has one attempt with one tool, opening it shows
`Thought for 2.1 s` and then a full `ToolRow`. That `ToolRow` repeats the name and
target already in the header. Render its body (output, thumbnails, error) without
the header line. Multi-tool attempts keep `ToolGroup` as today.

## 4. Live tool-call progress (host: Codex, webview: Claude)

**Host (Codex).**

- `OpenAIClient` already accumulates `tool_calls` argument fragments (`toolAccum`).
  Add an optional `onToolCallProgress?(p: { index, id, name, argChars, argDeltas })`
  handler.
- Throttle it to at most 4 events a second per call, plus a final event when the
  call closes.
- Thread the handler through `streamOnce` (`src/agent/toolCallingStream.ts`), the
  `ToolCallingLoop` options and `ModelTurn` / `PromptRun`, out to a new bridge
  message in `src/sidebar/messageBridge.ts`:

  ```ts
  { type: 'toolCallProgress'; conversationId?: string; index: number;
    toolCallId?: string; toolName: string; target?: string; tokens: number }
  ```

- `target` is a best-effort path pulled from the partial arguments with a
  whole-token regex (`"path"\s*:\s*"…"`), and only once the closing quote has
  arrived.
- `tokens` is the number of argument deltas. llama-server and Strata stream one
  token per delta. **Phase 0** checks that against Strata's own `generated` count
  for one large `write_file`. If deltas undercount by more than 10%, send
  `argChars` instead and label it `chars`.
- `OllamaNativeClient` receives tool calls whole, so it sends no progress. Say so
  in a comment and do not fake it.

Phase 0 measurement: not measured. Strata's log was advancing during the host
implementation, so no probe was sent while it was mid-turn. It moves to the
pre-tag live test: one large `write_file` on Strata, comparing the row's final
count with the log's `G generated` for that request.

**Webview (Claude).**

- The reducer keeps a transient `pendingToolCalls` map per conversation. It is
  not a message row.
- `MessageList` renders one dim row per entry, for example
  `○ write_file matchbox.html · writing… 4,210 tokens`.
- The entry is removed when the matching `toolActivity` (by `toolCallId`, or by
  index within the round) arrives, or on DONE or ERROR.

## 5. Ticking thinking timer (webview, Claude)

While a reasoning row is the live tail of a streaming conversation, its label
reads `Thinking… 42 s` and updates once a second. The webview stamps the start
time on the first `REASONING_TOKEN` of the span. Once sealed, the row shows the
existing `Thought for X` label. The 1 s interval is cleared on seal, on DONE and on
unmount.

## 6. "Stopped" line when the user stops a turn (host check: Codex, webview: Claude)

A turn the user cancels currently ends on whatever bubble was last. The matchbox
run, stopped at 20:47:47, ended on `Thought for 1.1 s` and looked hung.

- **Webview:** on `done` with `finishReason: 'cancelled'`, append a local dim
  notice row, "Stopped". It is not persisted, so a reload drops it. That is
  acceptable: it only matters live, and compaction notices behave the same way
  (transient `notice` messages).
- **Host (Codex):** confirm that every turn kind posts `done` with
  `finishReason: 'cancelled'` on a user stop, including the Telegram stop.
  `ProviderTurn` does today. Check `ModelTurn` / `PromptRun` (the llama.cpp and
  Strata path) and fix any path that posts a different reason or none.

## Out of scope

- Tokens/s in the progress row.
- Removing the ✓ (the owner keeps it).
- Progress for Ollama-native tool calls.

## State × lifecycle ledger

| Artifact | Create | Delete | Pause/disable | Crash mid-write | Owner-process death | TTL/expiry |
|---|---|---|---|---|---|---|
| "Stopped" notice row (webview memory) | `done` with `finishReason: 'cancelled'` | conversation switch or reload rebuilds rows from history, which never holds it | n/a | n/a: memory only | lost with the webview, by design | none |
| `pendingToolCalls` map (webview memory) | first `toolCallProgress` of a call | matching `toolActivity`, DONE, ERROR | n/a | n/a: memory only | lost with the webview; a reload rebuilds from history, which never holds pending entries | cleared at the turn end at the latest |

CI-enforced row: a reducer test asserts DONE and ERROR both empty `pendingToolCalls`,
so a later phase that adds a new turn-ending path fails it.

## Review notes (Claude, before delegation)

- First draft persisted the Stopped notice "like the compaction notice". Compaction
  notices are transient `notice` bridge messages, so item 6 is now webview-local
  and the ledger was updated.
- Item 4 `target` must not reuse `extractToolDetail` on partial JSON (it
  `JSON.parse`s and returns `''`), hence the regex on the partial string.
- Items 1-3 and 5 are webview-only. Item 4 spans both sides: the bridge type is
  Codex's file, and the webview codes against the shape in item 4.
- File ownership while both of us work in the main worktree:
  - Codex: `src/llm/*`, `src/agent/*`, `src/sidebar/*`.
  - Claude: `webview-ui/*`, `src/sidebar/toolSummary.ts` (item 1), `CHANGES.md`.
  - Neither of us edits the other's files.

## Acceptance criteria

- Item 1: `extractToolDetail` unit test. A shell command with spaces yields the
  unquoted command, and `displayDetail` of `cd "n:/a b" && grep -n x f` is
  `grep -n x f`. A DOM test shows a shell row without the `cd` prefix.
- Item 2: a unit test on the row builder.
  - 4 consecutive successful shell steps make 1 folded row, labelled
    `shell ×4 · grep, sed`.
  - A failed step or an edit step in the middle splits the run.
  - The DOM test expands the fold and finds 4 step rows.
- Item 3: a DOM test. A single-tool step opened shows the tool name once.
- Item 4:
  - An OpenAIClient unit test feeds 20 argument deltas and sees throttled progress
    events, ending with `argDeltas: 20`.
  - A reducer test: progress, then toolActivity, then the entry is removed; DONE
    clears all entries.
  - Phase 0's delta-versus-token measurement is recorded in this plan.
- Item 5: a DOM test with fake timers. A live reasoning row reads `Thinking… 3 s`
  after 3 s and `Thought for …` after seal.
- Item 6: a reducer test. `done` with `cancelled` appends one Stopped row, and a
  second `done` does not add another. A host test per turn kind shows a user stop
  posts `done` / `cancelled`.
- `npm run ci` green. The VSIX is packaged and installed, then live-checked on
  Strata with a jelly-press-sized task, before anything is tagged.
