# Sidebar UX — empty state, resumed marker, queue visibility, session selector

**Status:** implemented (all four phases), `npm run ci` green
**Date:** 2026-08-29
**Mockups:** [`SIDEBAR_UX_MOCKUPS.html`](./SIDEBAR_UX_MOCKUPS.html) — open in a
browser. Also published at
https://claude.ai/code/artifact/038931da-ba24-4281-95fc-fb42477f3b08
(the repo copy is canonical; the artifact may drift).

Four changes to the sidebar chrome, chosen from the reviewed mockups:

| # | Change | Mockup | Host changes |
|---|--------|--------|--------------|
| 1 | Empty tab shows the mark + live backend state | §01 panel C, **without** starter chips | none |
| 2 | Restored tab gets a "resumed" marker | §02 panel B | none |
| 3 | A queued prompt says what it is waiting on, and its tab shows it | §03 panel B | none |
| 4 | The session selector lists open tabs, with a live indicator | §04 panel B | none |

**Every phase is webview-only.** No new bridge messages, no new host fields,
no config schema change. That is the whole point of the sequencing: each phase
renders state the reducer already holds.

---

## Correction to the original §04 suggestion

The mockup drew spinners inside the history panel. **That cannot happen as
drawn**, and the earlier suggestion to add `streaming?: boolean` to
`SessionHistoryMeta` was wrong.

`historyMetasFromSession()` in `src/sidebar/sessionTypes.ts:449` filters open
conversations *out*:

```ts
const openIds = new Set(session.conversations.map((c) => c.id));
return session.history.filter((c) => !openIds.has(c.id))
```

So the panel behind the clock icon lists **closed** conversations only. A
closed conversation is never streaming, and a `streaming` flag on that type
would be dead the day it shipped.

What the mockup actually shows — one place to click that lists everything,
running items marked — is still exactly right. It just needs a different cut:
**the panel gains an "Open" section fed from `state.tabs`**, which already
carries `streaming` (`SessionTabMeta.streaming`, set by
`tabMetasFromSession()` at `sessionTypes.ts:445`). Phase 4 below does that,
and it needs *fewer* changes than the original suggestion — zero host-side.

---

## Phase 1 — Empty state

### Behaviour

When the active conversation has no displayable rows and no queued prompts,
the message area renders, centered:

- the Forge mark from `assets/icon.svg`, at 52px, `opacity: 0.16`
- `● <model name> · <residency>` — dot coloured by residency
- `<n> ctx per slot` when the per-slot window is known
- a third line only when it says something: `spawning llama-server…` while
  loading or `<provider>` for a remote model

No starter chips (dropped in review — they go stale and are not needed to
make the point).

State mapping:

| Condition | Dot | Line 1 | Line 2 |
|---|---|---|---|
| `residency === 'ready'` | green | `<name> · resident` | `<max> ctx per slot` |
| `residency === 'loading'` | amber | `<name> · loading` | `spawning llama-server…` |
| `residency === 'cold'` | grey | `<name> · not loaded` | `<max> ctx per slot` |
| no `residency` (remote) | green | `<name> · <provider>` | `<max> ctx per slot` |
| no active model | grey | `no model selected` | — |

`residency` is absent for every remote route by design — see the comment at
`src/sidebar/messageBridge.ts:100`. Rendering those as `cold` would advertise
a load cost that does not exist, so the remote row gets the provider instead.

### Where the data comes from

All required values are already in `App.tsx` before the first token:

- `state.models` / `state.activeModel` — `ModelsMsg`, dispatched on
  `webviewReady`. Match with `models.find((m) => m.name === activeModel)`,
  the same comparison `ModelSelector.tsx:93` uses (exact name including any
  `@profile` suffix — do not re-derive a base name here).
- `tokenMax` — `TokenBudgetMsg.max`, which is
  `perSlotContext(activeModel, config.llama_server)`
  (`ContextBudgetPublisher.ts:117`). It is published on conversation open and
  switch, not only after a turn, so it is populated on a fresh tab.
- Do **not** render a `backendReady === false` row in the empty state.
  `backendReady` is global while tabs can run independently, so a failure in a
  background tab could incorrectly mark an unrelated empty tab unavailable.
  The backend error is already appended to its affected conversation as a row;
  a conversation-scoped empty-state error would require a new host field and is
  deliberately out of scope for this webview-only cut.

### Files

**New — `webview-ui/src/components/EmptyState.tsx`** (~85 LOC)

```ts
interface Props {
  modelName: string | null;
  residency?: ModelResidency;
  provider?: string;
  contextMax: number;      // 0 = unknown, render no ctx line
}
```

Pure presentation: no `vscode.postMessage`, no effects. The mark is inlined as
JSX `<svg>` copied from `assets/icon.svg` (nine `<rect>`s, `fill="currentColor"`),
matching how `TabStrip.tsx` already inlines its icons.

**Changed — `webview-ui/src/components/MessageList.tsx`** (165 → ~172 LOC)

One new optional prop. Preserve the existing `#messages` shell (its flex and
scroll contract) and render the empty node *inside* it when there are no rows
and no queued prompts:

```ts
emptyState?: React.ReactNode;
```

```tsx
<div id="messages" ref={containerRef}>
  {rows.length === 0 && queuedPrompts.length === 0 && emptyState ? (
    emptyState
  ) : (
    <>{/* existing message rows, queued rows, and scroll anchor */}</>
  )}
</div>
```

`MessageList` stays ignorant of models and residency — App composes the node.
This is the seam that avoids threading four unrelated props through the list.

**Changed — `webview-ui/src/App.tsx`** (405 → ~420 LOC)

Build the node in a `useMemo` over `state.models`, `state.activeModel`, and
`tokenMax`, and pass it as `emptyState`.

**New — `webview-ui/styles/empty-state.css`** (~60 LOC), added to the
concatenation list in `esbuild.config.mjs:52-61` **after `layout.css`**.

Reuses `--forge-accent` and the existing `--forge-space-*` scale from
`base.css`. Residency dot colours reuse the `.ms-dot--*` classes from
`model-selector.css` rather than defining a second set — grep confirms those
are the only residency colours in the codebase and `docs/OWNERS.md` should
keep pointing at that file for them.

### Tests

> **Correction made during implementation:** this plan claimed `webview-ui`
> has no component test harness. It does — `test/webview/*.dom.test.ts` render
> real components into jsdom (`TabStrip`, `HistoryList`, `QueuedPromptRow`,
> and `App` itself). Every phase therefore got component coverage as well as
> the pure-function tests below, and the existing suites needed their new
> required props.

Extract the state mapping as

```ts
export function describeBackend(props: Props): { tone: 'ok'|'warn'|'idle'; primary: string; secondary?: string }
```

in the same file, and unit-test that table under `test/` with vitest. Six
cases: one per table row, plus the unknown-`contextMax` case that drops the
second line.

---

## Phase 2 — Resumed marker

### Behaviour

A conversation restored from a previous window session, that has not been
touched in this one, renders a hairline rule below the last message:

```
────── resumed · 3 days ago · 12 msgs ──────
```

It disappears the moment the user sends in that tab, and never reappears for
that tab in this window session.

### Rules

- Only when `messageCount > 0`.
- Only when `Date.now() - updatedAt > RESUMED_AFTER_MS`. Start at **4 hours**
  — long enough that "I closed the laptop for lunch" does not trigger it,
  short enough to catch the overnight case. One exported constant, easy to
  change after living with it.
- **Sticky, computed once.** On the first `SESSION_SYNC` that hydrates the
  session (`state.sessionHydrated` flipping true, `reducer.ts:298`), snapshot
  the set of conversation ids meeting the rule into React state. A small ref
  may guard the one-time capture, but the IDs themselves must be state so the
  post-hydration snapshot triggers a render. Reading `updatedAt` live would
  make the marker vanish as soon as any tab activity bumped the timestamp, and
  reappear on unrelated syncs.
- Remove an id from the set on `USER_SEND` for that conversation.

### Where the data comes from

`SessionTabMeta` already carries `updatedAt` and `messageCount`
(`messageBridge.ts:2-13`). **No bridge change.**

### Files

**Changed — `webview-ui/src/App.tsx`** (~420 → ~445 LOC)

The one-time hydration guard, `resumedIds` state, and a `resumedNote` string
computed for the active tab. Remove an ID with a functional state update in
both normal-send and Steer paths. Reuse `relativeTime()` — it is currently private to
`HistoryList.tsx:11`; **export it** rather than writing a second one
(single-point-of-truth rule), or lift it to a small
`webview-ui/src/relativeTime.ts` if a third caller appears. One caller moving
does not justify a new module yet, so: export from `HistoryList.tsx` and add
the row to `docs/OWNERS.md`.

**Changed — `webview-ui/src/components/MessageList.tsx`** (~172 → ~178 LOC)

`resumedNote?: string | null` prop, rendered after the last row and before the
queued rows.

**Changed — `webview-ui/styles/messages.css`** (+~14 LOC)

`.resumed-marker` — flex row, two `flex: 1` hairlines using
`--vscode-sideBarSectionHeader-border`, mono 9.5px label. Same construction as
the mockup.

### Tests

Extract the rule as a pure function and test it:

```ts
export function resumedTabIds(tabs: SessionTabMeta[], now: number): Set<string>
```

Cases: fresh tab (no), old empty tab (no), old tab with messages (yes),
boundary at exactly `RESUMED_AFTER_MS` (no — strict `>`).

---

## Phase 3 — Honest queueing

### What already exists

More than the mockup assumed. `QueuedPromptRow.tsx` already renders a queued
prompt with **Steer** and **Cancel**, and `App.tsx:190-196` already queues a
send when `state.streamingIds.has(conversationId)`.

### The two real gaps

1. **The label does not say what it is waiting on.** It reads `Queued`. It
   should read `Queued — waiting on <model>`.
2. **A queued prompt in a background tab is invisible.** `App.tsx:357` filters
   `queuedPrompts` to `prompt.conversationId === state.activeConversationId`.
   Switch away and the queued prompt vanishes from the UI entirely — nothing
   in the tab strip says that tab has work pending.

### Behaviour

- `QueuedPromptRow` shows `Queued — waiting on qwen3.8-27b`, falling back to
  `Queued` when no model name is available.
- `TabStrip` renders a **static amber dot** on any tab with a queued prompt,
  using the same slot as the streaming spinner.

**The two marks mean different things and must not be merged:**

- **spinner** (accent, animated) = a turn is generating
- **dot** (amber, static) = this tab is waiting — on the slot, or on you

A tab spinning while it is actually blocked reads as a hang. This is also why
the confirmation gate should eventually use the amber dot; that is out of
scope here but the CSS class is named so it can.

### Files

**Changed — `webview-ui/src/App.tsx`** (~445 → ~460 LOC)

Derive `queuedIds = new Set(queuedPrompts.map((p) => p.conversationId))`,
pass to `TabStrip`. Derive each queued row's model label from the matching
`SessionTabMeta.active_model`, rather than from the currently selected global
model; this keeps a background tab's label honest. Because `active_model` is
only emitted after an explicit per-conversation model choice, use
`tab.active_model ?? state.activeModel`; fall back to `Queued` only when there
is no model selected anywhere.

**Changed — `webview-ui/src/components/QueuedPromptRow.tsx`** (34 → ~40 LOC)
**Changed — `webview-ui/src/components/MessageList.tsx`** (~178 → ~185 LOC)
**Changed — `webview-ui/src/components/TabStrip.tsx`** (226 → ~236 LOC)

New prop `queuedIds: ReadonlySet<string>`. Render
`<span className="tab-waiting-dot" />` when `queuedIds.has(tab.id)` and the
tab is not streaming. Keep the existing `live && !sel` condition on the
spinner untouched — the collapsed-strip variant (§04 panel C) was **not**
selected, so `StreamingStatus` still covers the foreground turn.

**Changed — `webview-ui/styles/tabs.css` and new
`webview-ui/styles/sessions-panel.css`**

At the start of this phase, move the existing history-panel rules out of the
already 408-LOC `tabs.css` and into `sessions-panel.css`, then add the queue
and Phase 4 session-panel rules there. Add the new stylesheet to
`esbuild.config.mjs` immediately after `tabs.css`. This is a real concern seam
(tab strip versus sessions panel) and brings the tab strip back within the
project's practical 350-LOC limit.

`.tab-waiting-dot` — 7px, `--vscode-editorWarning-foreground` with a literal
amber fallback, no animation, so no `prefers-reduced-motion` guard needed.

### Tests

A set derivation and two conditional renders, so no pure function to extract.
Covered by DOM tests instead: `TabStrip` draws the dot for a queued tab and the
spinner for a streaming one, and never both on the same tab;
`QueuedPromptRow` names the model.

---

## Phase 4 — Session selector shows open tabs

### Behaviour

The panel behind the clock icon becomes a full session list in two labelled
sections:

```
OPEN
  ◜ refactor ConfigLoader          now      ← spinner, accent label
  ● write tests                    2m       ← amber dot, queued
    port gitCwd to relay           12m
CLOSED
    embeddings ubatch bug          6d       ← kebab menu, as today
```

- **Open** rows come from `state.tabs`. Clicking switches (`switchConversation`).
  The active tab is marked but not clickable-to-restore.
- **Closed** rows are today's rows, unchanged: restore, rename, delete.
- Live marks reuse Phase 3's semantics exactly — `.tab-streaming-spinner` for
  streaming, `.tab-waiting-dot` for queued.
- The clock button's count badge (`#history-toolbar-count`, `TabStrip.tsx:141`)
  keeps counting **closed** sessions only, so its meaning does not change.
  Rename its `title` from "Chat history" to "Sessions".

Rename the heading and labels in the UI to "Sessions"; **do not rename the
`historyRestore` / `restoreConversation` / `deleteConversation` message types
or `SessionHistoryMeta`** — those are the host contract and renaming them buys
nothing but churn.

### Where the data comes from

`state.tabs` (`SessionTabMeta[]`, already carrying `streaming`),
`state.activeConversationId`, and Phase 3's `queuedIds`. **Zero host changes.**

### Files

**Changed — `webview-ui/src/components/HistoryList.tsx`** (245 → ~305 LOC)

New props:

```ts
tabs: SessionTabMeta[];
activeId: string;
streamingIds: ReadonlySet<string>;
queuedIds: ReadonlySet<string>;
onSwitch: (id: string) => void;
```

`HistoryRow` stays as-is for closed rows. Add a leaner `OpenRow` — no kebab
menu, since an open tab is closed from the strip, not from here.

> 305 LOC is past the 350 soft threshold? No — it is under it, but only just,
> and the file would then hold two row kinds. If it lands above 350 in
> practice, the seam is `HistoryRow`/`OpenRow` into
> `webview-ui/src/components/SessionRows.tsx`, not an arbitrary cut. Decide
> against the real number after Phase 4 is written, not now.

**Changed — `webview-ui/src/App.tsx`** (~460 → ~465 LOC) — pass the new props.

**Changed — `webview-ui/styles/sessions-panel.css`** — section headings and
open-row states. The Phase 3 extraction keeps these session-panel concerns out
of `tabs.css` from the outset.

### Tests

DOM tests in `test/webview/HistoryList.dom.test.ts`: section order and labels,
switching from an open row, the active row being marked but still listed, the
spinner/dot split, and open rows having no kebab. The one rule not worth a test
— that an id appears in exactly one section — is guaranteed structurally, since
Open comes from `tabs` and Closed from `history`, which the host already made
disjoint at `sessionTypes.ts:450`.

---

## Ordering and independence

Phases are independently shippable and land in order. Phase 3 must precede
Phase 4 because Phase 4 reuses `queuedIds` and `.tab-waiting-dot`.

Nothing here touches: the agent loop, tool dispatch, the backend pool,
checkpoints, config, or persistence. If any phase turns out to need a host
change, that is a signal the cut is wrong — stop and re-plan rather than
adding a bridge field.

---

## Gates

```bash
npm run ci        # tsc, eslint (incl. max-lines), vitest, prod build
npm run package   # VSIX smoke
```

Per `docs/plans/` convention and the release gotchas: a new VSIX needs a
**full window reload** to verify — the exthost auto-restart reloads the old
build.

## Manual smoke

1. New tab → empty state shows the mark, the model, `ready`, and the per-slot
   ctx. Confirm the ctx figure equals `num_ctx / n_parallel`, not `num_ctx`.
2. `/unloadModel` → the same panel reads `cold` / `not loaded`.
3. Switch to a cloud model → provider line, no residency dot mismatch.
4. Send one message → empty state gone, does not flash back between rounds.
5. Reload the window on a tab last used yesterday → resumed marker present;
   send → marker gone; reload again → still gone, because sending refreshed
   `updatedAt`. It may qualify again only after a later window session starts
   more than four hours after that send.
6. Reload on a tab used 2 minutes ago → no marker.
7. Start a turn in tab A, send in tab B → B's row reads
   `Queued — waiting on <model>`; switch to A → B's chip carries the amber dot.
8. Open the sessions panel mid-turn → the running tab shows the spinner under
   OPEN; a closed session still restores, renames, and deletes.
9. Reduced motion on → the spinner is static, both in the strip and the panel.

## Docs

- `docs/OWNERS.md` — rows for `EmptyState.tsx`, `empty-state.css`, and
  `relativeTime` moving to an exported symbol.
- `CHANGES.md` — one entry per phase.
