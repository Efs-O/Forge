# Activity view — compact tool rows (A) and grouped steps (B) (impl plan)

Status: proposed 2026-10-09. Mockup reviewed and approved by the owner:
https://claude.ai/artifact/S5NWVCGUQTFULQJ4BArm4r

## Problem

A nine-call agent stretch renders as ~20 rows in the sidebar. Every reasoning
round gets its own `Thought for N s` row (`ThinkingGroup`), every edit is
followed by a separate `MODIFIED` diff card (`DiffGroup` → `DiffBlock`), and a
failed call followed by its successful retry costs two rows. The work is all
visible, but the transcript is hard to scan and the assistant's actual answer
gets pushed off screen.

Goal: fewer rows by default, with nothing hidden more than two clicks away,
and today's rendering kept as an opt-in.

## Today's pipeline (what this plan changes)

- `webview-ui/src/components/MessageList.tsx` — `toRows()` folds adjacent
  same-kind messages into four row kinds: `message`, `diffGroup` (runs of
  `role: 'diff'`), `thinkingGroup` (runs of reasoning-only assistant messages,
  `isReasoningOnly`), `toolGroup` (runs of `role: 'tool'`).
- `ToolGroup.tsx` — parallel calls of one round behind one `N tool calls` toggle.
- `ToolRow.tsx` — one call: status glyph, name, detail, `toolMs`, result size,
  `open` button, expandable result body, image thumbnails.
- `ThinkingGroup.tsx` — `ThinkingRow` + `thinkingLabel(reasoningMs)`.
- `DiffGroup.tsx` / `DiffBlock.tsx` — diff card with the `modified/new/deleted`
  badge; `diffStats(hunks)` already yields `+added −removed`.

### Live rows vs synced rows (reviewed 2026-10-09)

The webview holds two kinds of rows, and they do not carry the same fields:

| Field | Live row (reducer, during a turn) | Synced row (`displayPersistMessages` → `mergeSyncedMessages`, at turn end, tab switch, reload) |
|---|---|---|
| `toolName`, `toolIsError`, `toolResultTotal`, `toolMs` | yes | yes (`toolMs` when the host measured it) |
| `reasoning`, `reasoningMs` | yes | yes (`reasoningMs` when measured) |
| `toolDetail` (the args line, e.g. the shell command) | yes | only when the live row was still in the webview to copy it from. **Lost on reload.** Content becomes `name → <result label>`. |
| `toolFilePath` | yes | **no** |
| `toolCallId` | yes | **no** |
| diff ↔ tool link | none (`fileDiff` message has no `toolCallId`) | implicit: diffs are emitted right after their tool, matched by `toolCallId` on the host |

The first draft of this plan matched diffs by `toolFilePath` and merged repeats
by "same file". Both would have worked during a turn and then broken at turn
end, when `SESSION_SYNC` rebuilds the transcript. The view would visibly change
shape right as the answer arrived, and an archived session would never look like
the live one. Fix (phase 1b): carry the link on both paths.

- `fileDiff` (host → webview) gains `toolCallId`. `ToolDispatch.postFileDiff`
  already has it in scope; it is what `recordFileDiff` stores.
- `displayPersistMessages` emits `toolCallId` on tool rows and on the diff rows
  it already pairs by `toolCallId`. It also emits `toolTarget`: the path or
  detail string the live row shows. That is derived from the matching
  `tool_calls[].function.arguments` on the preceding assistant message, using
  the **same** label function the live announce path uses (find it at phase 1b;
  grep, do not write a second one).
- `mergeSyncedMessages` / `PersistedRow` / `sessionTypes.ts`: carry both fields.

Everything is optional and additive. A row without `toolCallId` (sessions
archived before this ships) gets no diff folding and no repeat merging. Its
diffs stay standalone rows, and that is the declared behaviour for old history.

**Not changed:** the model's context, the session JSONL, `slimPersistMessages`,
and anything remote. Whether display rows are themselves written to the history
file is checked at phase 1b. If they are, the two optional fields enter a durable
format and the ledger gains a row before any code is written.

### Telegram / remote: not affected

Telegram's live bubble is built by `src/remote/RemoteAgentProgress.ts` from host
`AgentProgressEvent`s (`remoteProgressRender.ts`, `remoteProgressText.ts`). It
never reads webview rows, `toRows`, or `displayPersistMessages`. The only other
reader of `displayPersistMessages` is `ConversationOps` (`role !== 'tool'`
archive check), which the new optional fields do not affect. The setting is read
by the sidebar host only. Telegram keeps its current progress format. Folding
the Telegram trace the same way would be a separate plan.

## Design

### The setting

`forge.sidebar.activityView`: `"grouped" | "compact" | "full"`, a VS Code
setting in `package.json` `contributes.configuration` (a UI preference, so it
belongs in `settings.json`, not `config.yaml`). The name follows the existing
`forge.sidebar.*` / `forge.editor.*` settings. There is no `forge.chat.*`
namespace.

- `full` — exactly today's `toRows()` output. Pinned by a test (phase 0).
- `compact` — Proposal A.
- `grouped` — Proposal B, which contains A inside each group.

Default: `grouped` (decided by the owner 2026-10-09). An invalid value is
reported, not silently mapped (see "No Fallbacks" in CLAUDE.md): the setting's
`enum` makes VS Code flag it in the settings UI, and the host parses it with Zod
at the boundary. On a parse failure the host posts a `system` row saying so and
renders `full`, the view that hides nothing. That is a declared, visible
behaviour, not a hidden fallback.

The host reads it once when the webview is built and re-sends it on
`workspace.onDidChangeConfiguration` (disposed via `context.subscriptions`).
New discriminated-union member in `src/sidebar/messageBridge.ts`:
`{ type: 'activityView'; mode: ActivityViewMode }`. The review found no existing
host→webview settings message, so this is the first one. Send it in the same
place the host answers the webview's ready/hydrate handshake, so a reloaded
webview never renders a frame in the wrong mode. Until the message arrives, the
webview renders `full`. This is a single-frame state, never a lasting one: the
host posts the mode before the first transcript sync.

### New pure module: `webview-ui/src/activityRows.ts`

`toRows()` moves out of `MessageList.tsx` into this module unchanged (phase 0),
then gains a mode parameter:

```ts
export type ActivityViewMode = 'grouped' | 'compact' | 'full';
export function toRows(messages: AppMessage[], mode: ActivityViewMode): Row[];
```

New row kinds:

```ts
| { kind: 'step'; step: ActivityStep }          // compact
| { kind: 'activityGroup'; steps: ActivityStep[]; live: boolean }  // grouped

interface ActivityStep {
  /** Reasoning-only assistant messages that preceded the call(s), in order. */
  thoughts: AppMessage[];
  /** Attempts of the same call, oldest first. Length > 1 = ×N or retry. */
  attempts: AppMessage[][];   // each attempt = one round's tool rows (1 = single call, >1 = parallel round)
  /** Diff rows produced by the final attempt, matched by file path. */
  diffs: AppMessage[];
}
```

Pure, no React: the tests drive it with plain `AppMessage` arrays.

#### Proposal A: how a step is built (compact)

1. **Thinking folds forward.** A run of reasoning-only messages attaches to the
   next tool round as `thoughts`. A trailing run with no tool after it (the
   model is about to answer, or the turn ended) stays a `thinkingGroup` row as
   today.
2. **Diffs fold into their edit.** A `role: 'diff'` row attaches to the step
   whose round contains a tool row with the same `toolCallId`. That works for a
   parallel round, where live diffs arrive after all of the round's tool rows,
   not after each one. A diff with no `toolCallId`, or with no matching tool,
   stays a standalone `diffGroup` row: never drop or misattribute one.
3. **Repeats merge.** A new single-call round merges into the previous step as
   another attempt when both are the same `toolName` on the same `toolTarget`
   (rows without a `toolTarget` never merge) **and** either
   - the previous attempt failed (`toolIsError`): retry, or
   - neither attempt produced a diff: plain repeat (`render_html_to_image ×2`).

   Edits that each produced a diff stay separate rows, so each `+N −M` is
   readable on its own. Parallel rounds (more than one call) never merge.
4. **Message boundaries.** Any `user`, `system`, `error`, or assistant message
   with content ends the current step. Steps never cross them. This includes
   *narration*, meaning assistant text sent alongside tool calls ("Now let me
   check X"). The latest Strata session had none (0 of 72 tool-call rounds), but
   cloud and CLI-agent models narrate, and for them B produces one group per
   narration line. That is accepted for v1 (see Open questions): narration stays
   visible as it is today, and nothing is folded behind it.

Header line for a step (`ActivityRow.tsx`, new):

```
▸ ✓ ✎ edit_file  pelican-joust.html  +24 −9                 ◔ 33 s
▸ ✓ render_html_to_image  pelican-joust.html  ×2           ◔ 27 s
▸ ✓ ✎ apply_line_edits  pelican-joust.html  [1 retry] +4 −4  ◔ 8.2 s
▸ ✕ apply_line_edits  pelican-joust.html                    ◔ 5.1 s   ← unrecovered failure stays red
```

- Status glyph comes from the **final** attempt. Any earlier failure shows the
  amber `N retry` chip. Failures are never hidden.
- `✎` and the diff counts appear only when `diffs` is non-empty; counts come
  from `diffStats()`. A diff whose `diffHunks` is `null` (too large, or a
  deletion) contributes no count, and the row shows `✎` alone, never `+0 −0`.
- `◔ N s` is the summed `reasoningMs` of `thoughts` (`thinkingLabel`'s
  formatter). Synced rows keep `reasoningMs` when the host measured it.
  CLI-agent turns are not timed, so a step with thoughts but no measurement shows
  `◔` with no number. With no thoughts at all: nothing.
- Header text after a reload: `toolTarget` when present (phase 1b), otherwise
  the row's existing content label, as today.
- Detail is display-shortened: a leading `cd <path> &&` / `cd <path>;` is
  stripped from shell commands (`displayDetail()` in `activityRows.ts`). The
  expanded body still shows the full original command.
- A pending call (no `toolResultTotal`, no error) **while the conversation is
  streaming** shows `○`, and the step renders expanded so a long run is never
  hidden. Once streaming stops, a still-pending row means the turn was cancelled
  or died mid-call. It does not force the step open (otherwise every cancelled
  turn would leave a stuck-open row) and shows its `○` as today.
- Tool approvals are a dialog (`ConfirmationDialog`), not a row, so collapsing
  can never hide one. The live test still checks this (phase 4).

Expanded body reuses the existing components, in chronological order:
`ThinkingRow` for each thought (export it from `ThinkingGroup.tsx`), `ToolRow`
for each attempt (or `ToolGroup` for a parallel round), then `DiffBlock` for
each diff. No second rendering of a tool result, thumbnail, or diff exists
anywhere: `ActivityRow` composes the existing components. Image thumbnails
stay visible on the collapsed row too (`ToolRow` already renders them under
the header; lift that block or render the final attempt's thumbnails), because
they are content, not chrome.

#### Proposal B: groups

A group is a maximal run of consecutive `step` rows plus `thinkingGroup` rows
between two message boundaries (rule 4). A run of one step renders as that step:
grouping one row behind a disclosure costs a click for nothing, the same rule
`DiffGroup` and `ToolGroup` already follow.

Header (`ActivityGroup.tsx`, new):

```
▸ ✓ 9 tool calls · ✎ 4 edits to pelican-joust.html +47 −18 · [1 retry] · ◔ 89 s thinking
```

- `✎` segment: one file → `N edits to <file>`; several → `N edits in K files`.
- The red `N failed` chip shows unrecovered failures; the amber chip shows
  recovered ones. Both are always on the header.
- **Live.** `live` is true for the group that contains the last message while
  that conversation is streaming (`state.streamingIds.has(id)`, the same flag
  `TranscriptPanes` already passes per pane, so a background tab's turn behaves
  the same as the visible one). A live group renders expanded and its header reads
  `● working · N calls`. When it stops being live (the answer starts or the turn
  ends), it collapses, **unless the reader toggled it by hand**: a manual
  toggle sticks for the life of the component.
- A group containing a pending call or an unrecovered failure starts expanded.

#### Expand state

Expand state is React component state, keyed by each row's first message id
(already the `key` in `MessageList`). It does not persist across a window
reload. This is deliberate, and it means the feature writes no durable state
other than the setting.

The keys must stay stable as a step grows (a retry appends to an existing step;
the first message id does not change), or the row would remount and lose its
toggle mid-turn. A test pins this.

They must also survive the turn-end `SESSION_SYNC`. `mergeSyncedMessages` keeps
a local row's id only when it matches a host row (`sameRenderableMessage`).
Unmatched rows get a fresh `mkId()`, and their step or group remounts, losing a
manual toggle exactly when B collapses the group. A test runs a live sequence
through `mergeSyncedMessages` and asserts that every step's and group's first id
is unchanged. If a row kind fails to match (for example a reasoning row whose
text differs after the host's split), fix the match, not the key.

### Memoization

`ToolGroup`, `DiffGroup`, and `ThinkingGroup` are `React.memo` with
`sameRowList`. `ActivityRow` and `ActivityGroup` do the same over the flattened
message list of their step(s). `toRows` stays inside the existing `useMemo` with
`mode` added to its deps.

### Scroll

`MessageList`'s `MutationObserver` already re-pins on DOM changes from
expanding rows, so collapse and expand need no new scroll code. Watch one case in
the live test: a group collapsing at answer start shrinks the content above the
streaming answer, and the pane must stay pinned to the bottom rather than jump.

## Phases

### Phase 0 — extract, no behaviour change
- Move `toRows` and `Row` from `MessageList.tsx` to `webview-ui/src/activityRows.ts`.
- `test/unit/ActivityRows.test.ts`: golden tests for today's folding (the
  screenshot's 9-call sequence, a parallel round, a trailing thinking run, an
  error row between tools). These become the `full`-mode contract.
- `docs/OWNERS.md`: row for `activityRows.ts`.
- Gate: `npm run ci`.

### Phase 1 — the setting
- `package.json`: `forge.sidebar.activityView` (enum + `enumDescriptions`, default
  per Open questions).
- Host: read, Zod-parse, post `activityView` on build and on change.
- `messageBridge.ts`: union member. Webview reducer: store the mode in app state
  and pass it to `MessageList` → `toRows`.
- With only `full` implemented, `compact` and `grouped` render as `full` and a
  test marks them `todo`. Nothing ships to users yet; this phase is not tagged.
- Gate: `npm run ci`.

### Phase 1b — link fields on both row paths (host)
- `fileDiff` gains `toolCallId`. `displayPersistMessages` emits `toolCallId` +
  `toolTarget` on tool rows and `toolCallId` on diff rows. `PersistedRow`,
  `sessionTypes.ts` and `mergeSyncedMessages` carry them. The reducer stores
  `toolCallId` on live diff rows.
- Find and reuse the live announce path's label function for `toolTarget`.
- Check whether display rows are written to the history file. If yes, add a
  ledger row first.
- Tests: projection emits the fields; a reloaded transcript (empty `local`) and
  a mid-turn sync both keep them; parallel-round diffs carry the right ids.
- Gate: `npm run ci`.

### Phase 2 — Proposal A (compact)
- `activityRows.ts`: `step` rows, rules 1–4, `displayDetail()`.
- `ActivityRow.tsx`: header plus a composed expanded body. Export `ThinkingRow`.
- CSS for `.activity-row*` in the existing sidebar stylesheet; follow
  `docs/plans/SOURCE_SPLIT_PLAN.md` on which file.
- Tests: each merge rule, both directions (merges when it should, stays separate
  when it should not); unmatched diff stays standalone; pending call expanded;
  shell `cd` prefix stripped only in display; key stability while a retry
  appends.
- Gate: `npm run ci`, then a live turn on Strata in `compact`.

### Phase 3 — Proposal B (grouped)
- `activityGroup` rows, live/collapse behaviour, manual-toggle stickiness.
- `ActivityGroup.tsx`.
- Tests: grouping boundaries, single-step pass-through, header counts (edits,
  files, retries, failures, thinking), live → collapse, manual toggle survives
  collapse, failure forces expanded.
- Gate: `npm run ci`, `npm run package`, then live test (below) before tagging.

### Phase 4 — ship
- `CHANGES.md` entry. README sidebar section: one line on the setting.
- Live test per the "live-test agent features before tagging" practice: install
  the local VSIX, run a real multi-edit turn on Strata in each of the three
  modes, cancel one turn mid-group, approve one gated call inside a group, and
  reload the window and reopen an archived session: a session from before this
  ships (no link fields) and one from after it. Confirm that the compact and
  grouped views look the same before and after the turn-end sync (no visible
  reshuffle when the answer arrives). Run one delegated CLI-agent turn
  (claude/codex), whose rows the host does not time. Confirm that a Telegram
  turn's progress bubble is unchanged.

## Files touched

| File | Change |
|---|---|
| `webview-ui/src/activityRows.ts` | **new**: pure row builder (moved `toRows` + A/B logic) |
| `webview-ui/src/components/ActivityRow.tsx` | **new**: compact step row |
| `webview-ui/src/components/ActivityGroup.tsx` | **new**: grouped header + body |
| `webview-ui/src/components/MessageList.tsx` | import `toRows`, pass `mode`, render the new kinds (gets shorter) |
| `webview-ui/src/components/ThinkingGroup.tsx` | export `ThinkingRow` |
| `webview-ui/src/components/ToolRow.tsx` | possibly expose the thumbnail block for reuse; no behaviour change |
| webview reducer / app state | hold `activityView` mode; store `toolCallId` on live diff rows |
| `src/sidebar/messageBridge.ts` | `activityView` message; `toolCallId` on `fileDiff` |
| `src/sidebar/ToolDispatch.ts` | pass `toolCallId` on `fileDiff` |
| `src/sidebar/sessionProjections.ts`, `sessionTypes.ts` | `toolCallId` + `toolTarget` on display rows |
| `webview-ui/src/messageOps.ts` | carry the two fields in `mergeSyncedMessages` |
| host webview-builder / provider | read + watch the setting |
| `package.json` | `forge.sidebar.activityView` contribution |
| sidebar CSS | `.activity-row*`, `.activity-group*` |
| `test/unit/ActivityRows.test.ts` | **new** |
| `docs/OWNERS.md`, `CHANGES.md`, README | rows / entry / one line |

Every new file is well under the 350-LOC soft threshold. `activityRows.ts` is
the largest, at roughly 200 lines.

## Out of scope

- Any change to what the model sees, the session log, or remote/Telegram output.
- Backfilling link fields into sessions archived before this ships.
- Persisting expand state across reloads.
- Collapsing assistant prose or user messages.
- A per-conversation override of the mode.

## Open questions

1. ~~**Default mode.**~~ **Decided 2026-10-09: `grouped`** is the default from
   the first release that ships B. Phase 2 (A alone) is not tagged on its own.
2. ~~**The `MODIFIED` card's inline diff.**~~ **Decided 2026-10-09: already
   open.** Inside an opened step, `DiffBlock` renders with its hunks expanded.
   **Reversed 2026-10-09 after the live install:** the hunks start collapsed;
   the opened step shows one `DiffBlock` header per file (name, `+N −M`) and
   its toggle opens the hunks. Opened steps with several edits were too long.
   Original question follows. Today, a single edit's `DiffBlock`
   shows its hunks on one click. Inside a compact row that becomes two clicks:
   the row, then the hunks. The plan proposes rendering the `DiffBlock` already
   expanded inside an opened step. Confirm.
3. ~~**Narration between tool calls.**~~ **Decided 2026-10-09: break the
   group** (rule 4 as written). Original question follows. v1 treats it as a boundary (rule 4), which
   is safe but folds less for models that narrate. The alternative is to keep
   narration inside the group as dim lines and show the latest narration line on
   the collapsed header. Decide after phase 3 using a cloud-model session.

## State × lifecycle ledger

One durable artifact: the setting. Expand/collapse state is component state,
deliberately not persisted, and the session log and history files are not
written by this feature.

| Artifact | Create | Delete | Pause/disable | Crash mid-write | Owner-process death | TTL/expiry |
|---|---|---|---|---|---|---|
| `forge.sidebar.activityView` in user/workspace `settings.json` | Written only by VS Code's settings UI or the user's own edit; Forge never writes it. Absent = the contributed default. | User removes the key → `onDidChangeConfiguration` fires → host re-posts the default; webview re-renders. | Setting it to `full` is the disable: byte-for-byte today's rendering, pinned by the phase-0 golden tests. | Owned by VS Code's settings writer. A torn or invalid value fails the host's Zod parse → visible `system` row + `full` rendering (declared, not silent). | Webview reloads → host re-reads on build and re-posts. No in-flight state to lose; expand state resetting to defaults on reload is by design. | None. A user preference does not expire. |

CI-enforced row: the **Pause/disable** cell. Phase 0's golden tests pin `full`
mode to the pre-change folding, so any later phase that changes `full` output
fails CI.

## Acceptance criteria

- `forge.sidebar.activityView` exists with the three values and switches the view
  live, with no reload needed.
- `full` renders identically to the pre-change sidebar (golden tests green).
- `compact`: the reviewed 9-call sequence renders as 7 rows plus the trailing
  thinking row. Each row expands to the same `ToolRow`/`ThinkingRow`/`DiffBlock`
  content shown today.
- `grouped`: the same sequence renders as one header row. It is expanded while
  the turn runs and collapses when the answer starts. A manual toggle survives
  the collapse.
- An unrecovered failure is visible (red) on the collapsed row and on the group
  header. A recovered one shows an amber retry chip. A pending call or approval
  is never collapsed out of view.
- No diff is dropped or attached to the wrong call. Unmatched diffs render
  standalone.
- The compact and grouped views have the same rows before and after the
  turn-end sync and after a window reload, for sessions recorded after this
  ships.
- Host changes are limited to the two optional display-row fields and the
  setting message. Session log, remote surfaces, and model context are
  unchanged. Check with a before/after diff of one session's JSONL for the
  same turn shape.
- `npm run ci` and `npm run package` are green, and the live Strata test from
  phase 4 has passed in all three modes before tagging.
