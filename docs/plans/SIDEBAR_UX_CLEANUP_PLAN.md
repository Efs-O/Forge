# Sidebar UX Cleanup Plan

Seven items raised 2026-08-16 from live use. One is a real bug (#3); the rest
are presentation. Ordered by risk, cheapest and safest first.

Reference shape: the Codex and Claude Code sidebars — compact rows, one summary
card per turn, chrome proportional to information.

---

**Status 2026-08-16: all seven phases implemented.** CI green, VSIX packaged
and installed. Deviations from the plan as written are recorded in each phase.

---

## Phase 1 — Cross-tab checkpoint bug (real bug) — DONE

**Symptom:** open a new tab before pressing Keep/Undo and the bar shows in the
new chat.

**Cause:** [`checkpointPending`](webview-ui/src/reducer.ts#L25) is a single
global boolean; `CHECKPOINT_READY` ignores `action.convId`. The host already
sends the id — [`postC`](src/sidebar/AgentLoop.ts#L266) stamps
`conversationId` on every post — the webview discards it.

**Change:**
- `checkpointPending: boolean` → `checkpointPendingIds: Set<string>`, keyed the
  same way as `streamingIds`.
- `CHECKPOINT_READY` / `CHECKPOINT_DISMISSED` add/delete by `resolveConvId`.
- `USER_SEND` clears only its own conversation.
- Bar visibility: `checkpointPendingIds.has(activeConversationId)`.
- Drop the id when a tab closes.
- Host: stamp `conversationId` on the `checkpointDismissed` posts in
  [`undo()`](src/sidebar/SidebarProvider.ts#L197) and
  [`keep()`](src/sidebar/SidebarProvider.ts#L204).

**Tests:** reducer unit test — READY on conv A, switch to B, bar hidden; switch
back, bar shown.

---

## Phase 2 — Diff wall → one summary card per turn — DONE

**Symptom:** every edited file renders its own fully expanded diff block.

**Cause:** diffs are standalone `role: 'diff'` messages posted per write
([ToolDispatch.ts:271](src/sidebar/ToolDispatch.ts#L271)) and
[`DiffBlock`](webview-ui/src/components/Message.tsx#L53) only auto-collapses a
single file past 50 lines.

**Change:** purely a rendering grouping in `MessageList` — no host, bridge, or
persistence change.
- Fold runs of adjacent `role: 'diff'` messages into one `<DiffGroup>`.
- Header: `Edited 3 files  +102 −16`, collapsed by default.
- Expanded: one row per file (`badge · path · +N −M`), each row expanding to its
  hunks. Existing `DiffBlock` becomes the row body.
- Filename click → `openFile` (extended in Phase 5 to the native diff).
- `DiffGroup` lives in its own file; `Message.tsx` is already near the LOC cap.

**Tests:** three consecutive diff messages render one header with summed
stats; a diff separated by an assistant message starts a new group.

---

## Phase 3 — Checkpoint bar: merge Keep into dismiss — DONE

**Question raised:** is Keep needed, given the writes are already on disk?

**Finding:** the writes *are* on disk — nothing is staged. But Keep is not a
no-op: [`CheckpointStack.keep()`](src/checkpoint/CheckpointStack.ts#L257) pops
the checkpoint and discards its disk snapshots, and
[`SidebarProvider.keep()`](src/sidebar/SidebarProvider.ts#L201) clears the
CodeLens and gutter decorations. It means *finalize*, not *save*. The label is
what misleads.

**Change:** replace the two-button bar with one summary row.

```
⊞  Edited 3 files  +102 −16                    Undo ↩    Review    ✕
```

- `✕` calls the existing `keep()` — dismissing *is* keeping. No user ever has to
  wonder whether their changes are safe.
- `Review` opens VS Code's native multi-file diff for the turn's paths.
- Stats come from the same grouped diff data as Phase 2.

**Snapshot leak — fixed differently from the plan.** Finalising the previous
checkpoint on every new turn would have destroyed multi-level undo, which the
stack genuinely supports (`undo` pops one checkpoint at a time). Instead the
stack is capped at `MAX_CHECKPOINT_DEPTH` (20) and evicting the oldest releases
its disk snapshots — bounded memory, recent undo depth preserved. See
`src/checkpoint/checkpointHistory.ts`.

**Tests:** dismiss calls `keep()`; a new turn finalizes a pending checkpoint
exactly once.

---

## Phase 4 — Thinking-bubble wall — DONE (one finding deferred to Phase 6)

**Symptom:** after a long agent turn the transcript is a stack of `FORGE` /
`THINKING` bubbles with no visible work between them.

**Cause:** [`REASONING_TOKEN`](webview-ui/src/reducer.ts#L181) appends to the
last message only when it is already an assistant message. A tool row lands
between every round, so each round opens a *fresh* assistant message with empty
content and reasoning only. Each renders a full wrapper — role label, bordered
bubble, toggle — for zero visible content.

**Step 4.0 — resolved by inspection, no live turn needed.** Tool rows *are*
emitted per call ([AgentLoop.ts:765](src/sidebar/AgentLoop.ts#L765)) and are
visible during the turn. They disappear when the turn ends because
`SESSION_SYNC` rebuilds each conversation from persisted `user`/`assistant`
rows and re-appends only surviving `error` and `diff` messages —
[reducer.ts SESSION_SYNC](webview-ui/src/reducer.ts) drops every `tool` row.
That is exactly "the work in between them is not visible": live progress, then
a wall of bubbles once reconciliation runs.

It also explains why grouping works at all — with the tool rows gone, the
per-round reasoning messages become adjacent.

**Fixed in Phase 6**, via `mergeSyncedMessages` in
`webview-ui/src/messageOps.ts`: reconciliation now walks the local and persisted
lists together, so tool rows, diffs and errors keep their original positions
instead of being appended to the tail or dropped.

**Change:**
- Reasoning-only assistant messages (empty `content`) render with no role label
  and no bubble — one compact row, `▸ Thought for 12s`, styled like the existing
  `msg-tool-row`.
- Consecutive reasoning-only rows fold into one group, `▸ Thinking (7 steps)`,
  reusing the Phase 2 grouping helper.

**Optional follow-up (defer):** one collapsible "work log" region per turn
holding all reasoning *and* tool rows, auto-collapsing to a single line when the
final assistant text arrives. Same grouping code; decide after Phase 4 lands.

**Tests:** five reasoning-only messages render one grouped row; a reasoning
message that later gains content renders as a normal assistant message.

---

## Phase 5 — Clickable paths and links — DONE

**Current state:** `forge-file://` markdown links already open files
([Message.tsx:26](webview-ui/src/components/Message.tsx#L26)). Nothing generates
them for a path the model merely typed, so `src/foo.ts` is dead text.

**Change:**
- Linkify pass in [markdown.ts](webview-ui/src/markdown.ts) — render-time only,
  saved message text untouched, matching that file's existing contract.
  - path-shaped tokens → `forge-file://`. Guard: must contain `/` or `\` **and**
    end in a known source extension; optional `:42` line suffix. The extension
    requirement is what stops prose like `and/or` being linkified.
  - bare `http(s)://` → external link.
- Extend [`OpenFileMsg`](src/sidebar/messageBridge.ts#L280) with
  `line?: number` and `beside?: boolean`.
- Plain click opens; ctrl/cmd+click opens beside (`ViewColumn.Beside`).

**Tests:** linkify unit tests over a fixture list — real paths linkified, `and/or`
and `24/7` and bare prose left alone, `:42` parsed into `line`.

---

## Phase 6 — Long agent replies are truncated — DONE

**Symptom:** a delegate's long report is cut off in chat.

**Cause:** [ToolDispatch.ts:322](src/sidebar/ToolDispatch.ts#L322) caps every
non-read-only tool result at 600 chars, strips its newlines, and wraps it in
inline code inside a blockquote — posted as a `token`, i.e. injected as fake
markdown into the assistant message stream. That injection is why it cannot be
collapsed: it is not a message. The model still receives the full result; only
the display is mangled. The newline strip does more damage than the cap.

**Change:**
- Add a `toolResult` bridge message (name, result text, duration, byte count)
  and stop injecting tool previews as `token` text.
- Render via the existing `role: 'tool'` path as a collapsible card: header
  `codex · 4.2s · 3.1k chars`, ~3 preview lines collapsed, full markdown-rendered
  body when expanded.
- Raise the stored display cap to ~16k chars with an explicit
  `[truncated — N of M chars]` marker (reuse
  [`capResultText`](src/tools/resultCap.ts#L10)); keep newlines.
- Read-only tools keep today's compact one-line row.

**Carried in from Phase 4:** `SESSION_SYNC` currently discards every `tool` row
at the end of a turn, so the agent's work vanishes from the transcript the
moment it finishes. Fixing that is part of this phase — either persist tool
rows alongside user/assistant rows, or give the reducer enough position
information to splice non-persisted rows back where they belong.

**Migration note:** persisted transcripts contain the old blockquote text baked
into assistant messages. Do not attempt to rewrite history — old turns keep
rendering as they are; only new turns use `toolResult`.

**Tests:** bridge round-trip for `toolResult`; a 40k-char result caps with the
marker and preserves newlines; read-only tools unchanged.

---

## Phase 7 — Queued prompts are invisible

**Symptom:** the Queue button works but the queued prompt is never shown.

**Cause:** by construction — [App.tsx:48](webview-ui/src/App.tsx#L48) holds the
queue in a `useRef` precisely to avoid rendering it, after a state-backed queue
caused dispatch-during-render re-entrancy.

**Change:** move the queue into the reducer with an explicit `ENQUEUE` /
`DEQUEUE` / `REMOVE_QUEUED` action set, drained only from an effect. The original
bug was dispatch *during render*; an effect-only drain does not reproduce it.
Keep the ref-based guard against double-drain.

- Pending strip directly above the input row: one chip per queued prompt,
  truncated text + `✕`.
- Clicking a chip returns its text to the composer for editing (reuses the
  existing `prefillText` path) and removes it from the queue.

**Tests:** enqueue while streaming renders a chip; DONE drains exactly one;
remove splices the right entry; the existing anti-re-entrancy test stays green.

---

## Sequencing

1, 2, 4, 7 are webview-only and independently shippable. 3 depends on 2 for its
stats. 5 and 6 touch the bridge; 6 should land before the optional Phase 4
follow-up, since it changes what a "work log" would contain.

Gate every phase on `npm run ci`, and `npm run package` before the VSIX install.

## Out of scope

- Rewriting persisted transcripts (see Phase 6 migration note).
- Restyling the composer, tab strip, or header.
- Any change to checkpoint *semantics* — Phase 3 changes labels and cleanup
  timing only, never what is written to disk.
