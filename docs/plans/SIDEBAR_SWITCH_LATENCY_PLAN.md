# Sidebar switch latency — why a tab switch costs 1–2 s, and how to make it instant

Status: implemented 2026-09-07, except F2 (see below). Written 2026-09-07.

## Symptom

Switching between Forge chat tabs, or leaving the VS Code window (e.g. to Claude
Code) and coming back, stalls for ~1–2 s once conversations carry real context.
It reads like "memory loading". It is not: nothing is being loaded from disk on
that path. Forge is rebuilding and re-shipping the *entire* multi-conversation
session on every switch.

## Measurement

`state.vscdb` for this workspace, key `Efsoo.forge-llm`:

```
16 088 817 bytes   Efsoo.forge-llm          <- Forge's persisted session
    44 876 bytes   memento/…textFileEditor  <- next largest key
```

16 MB. Other workspaces on this machine hold 37 MB / 29 MB / 26 MB `state.vscdb`
files, dominated by the same key. Every one of the costs below scales with that
number, and none of them scale with what the user is actually looking at.

## The four costs on a tab switch

`ConversationTabs.switch()` → `deps.refreshUi()` → `persistSession()` +
`postModels()` + `postSessionSync()` + `postTokenBudget()`.

### 1. The host reserializes and rewrites all 16 MB (extension host, blocking)

`refreshUi` calls `host.persistSession()` → `saveSidebarSession` →
`runtimeToPersisted(session)` ([sessionPersistence.ts:308](../../src/sidebar/sessionPersistence.ts#L308)),
which walks every message of every open tab *and* all archived history and
builds a fresh object graph, which VS Code then JSON-serializes into sqlite.
Synchronous on the extension host. Nothing about the transcripts changed —
only `activeConversationId` did.

The same call fires from `agentLoop.setTranscriptChangedListener`
([sidebarWiring.ts:178](../../src/sidebar/sidebarWiring.ts#L178)), i.e. once per
tool round during a turn.

### 2. The host ships every transcript to the webview, every time

`buildSessionSyncMessage` ([sidebarPayloads.ts:71](../../src/sidebar/sidebarPayloads.ts#L71))
includes `slimMessagesById(sidebar)`
([sessionTypes.ts:445](../../src/sidebar/sessionTypes.ts#L445)), which returns
transcripts for **every open conversation (≤12) and every archived history entry
(≤40)** — up to 52 transcripts — as one `postMessage`. That payload is
structured-cloned across the extension-host ↔ webview boundary on every switch,
every model pin, and every transcript change mid-turn.

The webview renders exactly one of those 52.

### 3. The webview reconciles all 52 transcripts, quadratically

`SESSION_SYNC` ([reducer.ts:367](../../webview-ui/src/reducer.ts#L367)) loops
every id in `messagesById` and calls `mergeSyncedMessages`
([messageOps.ts:77](../../webview-ui/src/messageOps.ts#L77)), which:

- allocates a brand-new object per row (`rows.map(...)`) for all 52 transcripts;
- then, per local row, runs `reconstructed.findIndex(...)` — a fresh scan from
  index 0 with full `content`-string comparisons — making the match O(n·m) in
  transcript length. At ~1000 rows (the size an audited session reached) that is
  ~500 k string compares for one conversation.

The `findIndex` predicate already rejects anything below `hostCursor`, so the
scan is doing nothing a forward-advancing cursor would not do in O(n+m).

### 4. The webview remounts the whole transcript DOM

`MessageList` is not virtualized — every row is a live component. On a tab
switch the `messages` prop is a different conversation, so every key changes and
React unmounts ~1000 rows and mounts ~1000 new ones, each running `react-markdown`
+ `rehype-highlight`. `Message` is `React.memo`'d and its props are primitives, so
it survives a *sync* — but a memo cannot survive a *remount*.

`ToolGroup`, `ThinkingGroup` and `DiffGroup` are not memoized at all (plain
exported functions) and take freshly-allocated arrays, so they re-render on every
sync even without a switch.

### Why refocusing from Claude Code is also slow

`retainContextWhenHidden` is on ([extension.ts:368](../../src/extension.ts#L368)),
so the DOM survives — the cost is repainting/compositing that very large DOM plus
flushing whatever the browser throttled while hidden (the failure mode already
documented in `Message.tsx`'s memo comment). The `MutationObserver` in
`MessageList` watches `{childList, subtree, characterData}` over the entire list
and calls `scrollToBottom` on every mutation, so a flush of backlogged work
re-enters layout repeatedly.

## Fixes, in order of payoff per unit of risk

### F1 — Send only the transcripts the webview can show (biggest win, low risk)

Change `slimMessagesById` to take an id set, and have `buildSessionSyncMessage`
include only the active conversation plus any streaming conversation. History
transcripts already have a restore path; make the webview request one by id when
the user opens it, and cache it.

Kills most of cost 2 and most of cost 3 in one edit. Payload drops from ~52
transcripts to 1–2.

### F2 — A transcript revision, so an unchanged transcript is never resent

Add `rev: number` to `ConversationRuntime`, bumped by the mutators in
`transcriptMutations.ts` (single owner). Put `rev` on `SessionTabMeta`. The
webview caches `id → {rev, messages}` and requests a transcript only when its
cached `rev` is stale or missing.

With F1+F2, a switch to an already-visited tab sends **metadata only** — tabs,
history metas, active id — a few KB.

### F3 — Make the reconciler linear, and skip it on hydrate

In `mergeSyncedMessages`, replace `reconstructed.findIndex(...)` with a forward
scan from `hostCursor` (semantically identical, O(n+m)), and early-return the
plain reconstruction when `local.length === 0` — which is exactly the tab-switch
and reload case.

### F4 — Don't rewrite 16 MB when only the active id changed

Split persistence: `refreshUi` on a switch should persist the *pointer*
(`activeConversationId`) without rebuilding the transcript graph. In order of
preference:

1. Store `activeConversationId` under its own small memento key, and write the
   transcript blob only when a transcript actually changed (reuse F2's `rev`).
2. Failing that, debounce/coalesce `saveSidebarSession` — but note this only
   moves the cost, it does not remove it from the extension host.

Worth doing regardless: archived history transcripts are re-serialized on every
write even though they are immutable. Persisting history under a separate key
would mean an active-tab write never touches it.

### F5 — Rendering: stop remounting, then stop rendering what is off-screen

1. `React.memo` on `ToolGroup` / `ThinkingGroup` / `DiffGroup` with an
   id-sequence comparator. Cheap, helps every sync.
2. Keep the open tabs' `MessageList` instances mounted and toggle visibility
   (`hidden`) instead of swapping the `messages` prop. Bounded by ≤12 tabs; makes
   a switch back to a visited tab a pure CSS change. This is the one that makes
   switching feel *instant*.
3. Virtualize the list (render only rows near the viewport). Biggest structural
   change; it is also the only fix that addresses the refocus-repaint cost,
   because it is the only one that reduces DOM node count. Do it last, and only
   if 1+2 have not made the refocus acceptable.
4. Narrow the `MutationObserver` — `characterData: true` over the whole subtree
   fires for every streamed token in every nested pane.

## What shipped

| Fix | Where |
| --- | --- |
| F1 — active + streaming transcripts only | `slimMessagesById(session, ids)`, `buildSessionSyncMessage` |
| F3 — linear reconciler + hydrate early-return | `mergeSyncedMessages` |
| F4 — pointer-only persistence on a switch | `saveActiveConversationId`, `ConversationTabs.switch` |
| F5.1 — memoized group rows | `ToolGroup` / `ThinkingGroup` / `DiffGroup`, `sameRowList` |
| F5.2 — one mounted pane per visited tab | `TranscriptPanes`, `MessageList`'s `active` prop |
| F5.3 — `content-visibility` on rows | `.messages-pane > *` in `layout.css` |
| F5.4 — auto-scroll skipped for hidden panes | `MessageList`'s `activeRef` guard |
| (unlisted) badge counts without building the rows | `countDisplayMessages` |

Two departures from the plan as written. F1 needed no by-id request path: the
active id is always in the set the host sends, so the webview can never be asked
to show a tab it has no rows for, and a partial `messagesById` plus a webview-side
cache covers the rest. F5.4 narrowed *when* the observer acts rather than what it
observes — `characterData: true` over the subtree is still what notices text
streaming into a nested pane, but a hidden pane no longer chases it.

Two things worth recording that the diagnosis above missed:

**The badge count was a third full walk.** `tabMetasFromSession` and
`historyMetasFromSession` each called
`displayPersistMessages(...).filter(...).length` — materialising all 52
transcripts, capping every tool body, to read 52 integers. `countDisplayMessages`
computes the same number without allocating. It is derived independently now, so
`sessionTypes.test.ts` asserts the two agree; that test is the only thing keeping
them in step.

**F5.2 and the refocus complaint pull against each other.** Keeping every visited
tab mounted means *more* live DOM, which is the thing that makes returning to the
window slow. `content-visibility: auto` is what makes them compatible: off-screen
rows are neither laid out nor painted, so the repaint cost tracks the viewport
rather than the transcript, and holding twelve panes costs little. It also means a
freshly shown pane reports estimated heights until rows scroll into view, which is
why `settleToBottom` re-pins over the next two frames instead of scrolling once.

## F2 (per-transcript revision) was deliberately not done

The plan called for a `rev` counter on `ConversationRuntime`, bumped by
`transcriptMutations.ts` as the single owner. `transcriptMutations.ts` is not
that owner: `conv.messages` is pushed to from `CliTurn`, `ModelTurn`,
`StreamedAssistantTurn` and `ToolCallingLoop` (which mutates the same array
through its own `options.messages` alias). A counter maintained by hand across
those sites goes stale the first time a site is added and forgets to bump it —
and a stale `rev` does not cost latency, it shows the user the wrong transcript.
That is a correctness bug traded for an optimisation on a path F1 has already
made cheap: one transcript, not 52.

If it is ever wanted, the sound version is a signature derived from the messages
rather than maintained alongside them, computed only for the ids a sync is about
to carry.

## What not to conclude

This is not model, VRAM, or backend latency, and it is not disk I/O on the switch
path. It reproduces with the backend idle. Do not tune llama-server for it.
