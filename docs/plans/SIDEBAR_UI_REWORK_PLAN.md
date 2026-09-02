# Sidebar UI rework — space allocation in the 382 px column (impl plan)

**Goal:** the sidebar spends roughly a third of its height on the transcript and
the rest on chrome. Nothing here is a restyle for its own sake — every item
below moves a control that is in the wrong place, or deletes one that duplicates
a control that already works.

Visual reference: `docs/design/sidebar-rework-preview.html` (open in a browser —
current and proposed rendered side by side at the real 382 px, with the option
set for Clanker mode).

**Scope discipline (no complexity):** webview only. No host changes, no bridge
messages, no new state on the extension side. Six of the seven items are CSS
plus a moved JSX node; one adds a single optional field to `AppMessage`. Two
further items are named and deliberately **not** in this pass, with reasons, at
the bottom.

---

## What the audit got wrong first

Two claims from the first review pass did not survive reading the code, and the
plan is smaller because of it:

- **"Clanker resets on window reload."** It does not.
  `sidebarWiring.ts:118` restores it from `workspaceState['forge.clankerMode']`
  at startup, written on every toggle via `rememberClankerMode`. It is
  workspace-scoped and durable. This makes the *display* more important, not
  less: the mode can be on from three days ago.
- **"Nothing records the flip in the transcript."** `SlashCommandHandler.ts:172`
  already posts `💥 **Clanker Mode ON** — no confirmation prompts…` as a notice.
  What is missing is narrower: the notice lands only in the conversation where
  `/clanker` was typed, while the flag is global to the workspace.

---

## 1 · Header — one row, and the real mark

`Header.tsx` renders two stacked rows: `#workspace-root` (10 px, workspace name)
and `#token-budget` (a full-width 3 px track plus a right-hand label). The track
spans the panel to represent a number that is usually 0 at the start of a
session, so at rest it reads as a stalled progress bar.

`#forge-logo-row` / `#forge-logo-text` / `#forge-logo-icon` exist in
`layout.css` but **nothing renders them** — dead CSS from an earlier header.

Merge both rows into one:

```
[◆ mark]  workspace-name …………………  [▁▁▃ 12.4k / 58k]
```

- The mark is `assets/icon.svg`'s geometry (pinned chip) inlined in
  `Header.tsx` at 14 px, filled with the `forgeGlow` gradient copied from
  `assets/publisher-logo.svg` (`#ffd24a → #ff9a1f → #e8530e`). Not the full
  publisher logo: its chip body is `#111111` and vanishes on a dark sidebar,
  and the pixel-art `?` inside it is a 5×7 grid at 7 px pitch that turns to
  mush below ~24 px. The full mark stays the Marketplace tile.
- `#token-budget-bar-track` loses `flex: 1` and takes a fixed `46px`.
  `budgetColor()` is unchanged — the thresholds already exist and are right.
- Net: one row saved, and the wordmark gained.

The stale-workspace warning keeps its own colour and its title text verbatim.

## 2 · Sessions panel — overlay, not a pusher

`#forge-root` is a flex column, and `<aside id="chats-panel">` is a sibling
between the header and `#messages`. So `historyExpanded` pushes the transcript
down by the panel's full height (~200 px) for as long as it is open.

- `#chats-panel` gets `position: relative`; `#history-panel` gets
  `position: absolute; top: 100%; left/right: 0; z-index: 20` with the
  editor-widget background and a border, so it floats over the transcript.
- `#history-list` loses its `max-height: 160px` in favour of
  `max-height: min(50vh, 320px)` — the whole point of the flyout is that it can
  be large without costing the transcript anything.
- Escape and an outside click close it. `HistoryList` already implements
  exactly this contract for its own kebab menu (`HistoryList.tsx:100-115`);
  lift that effect to the panel and keep one owner for the behaviour.
- **The "Open" group goes.** `TabStrip` above it already lists every open tab
  with the same spinner and queued dot, so `OpenRow` renders the active session
  a second time directly under its own chip. `OpenRow` and the `Open`/`Closed`
  `session-section-label`s are deleted; the panel becomes the closed-session
  list it is named for, and `HistoryList` sheds the `tabs` / `activeId` /
  `streamingIds` / `queuedIds` / `onSwitch` props that only fed it.

The tab strip **stays**. Multi-tab conversations are a product feature, tabs
stream in the background, and the strip is the only surface that shows that.

## 3 · Model selector — into the composer action row

`InputRow.tsx` renders `#model-row` as a full-width row above `#prompt-area`.
Move `<ModelSelector>` into the action row beside the attach button, so the row
reads: attach · model · spacer · action. `#model-row` is deleted.
`model-selector.css` keeps the trigger's own styling; only its container
changes, and the picker stays anchored to the trigger.

## 4 · The Queue button — delete it

`InputRow.tsx:346` renders `#btn-send` labelled "Queue" while streaming, calling
the same `submit` that `Enter` calls at line 231. The result already announces
itself: `MessageList` renders `QueuedPromptRow` — a dashed row reading
`Queued — waiting on <model>` with **Steer** and **Cancel** on it. The button
duplicates a working key to produce feedback that appears somewhere else.

- The streaming branch renders `#btn-stop` alone.
- A `#composer-hint` line under the actions reads
  `Enter queues this for the next turn` while streaming, `Enter to send` when
  idle. Same information, one fifth of the pixels, and it covers the
  discoverability the button was carrying for a mouse-only user.
- `#input-btn-col` becomes `#input-actions`, `flex-direction: row`, which gives
  the textarea the full panel width back (~150 px recovered).

## 5 · Transcript — anchored to the bottom

`#messages` is `flex: 1; overflow-y: auto` with content top-aligned, so a short
conversation floats at the top with the void beneath it and the live status line
hundreds of pixels from the text being written.

`#messages > *:first-child { margin-top: auto; }` — content sits at the bottom
when it is short, and scrolls normally when it is not. Deliberately **not**
`justify-content: flex-end`, which makes overflowing content unreachable at the
top of a scroll container in Chromium.

`StreamingStatus` gains an elapsed-seconds counter (`8.3 s`) beside the rotating
phrase, on a 100 ms interval that runs only while `streaming` is true. The
rotation stays: a motionless indicator cannot distinguish working from hung, and
that reasoning in the component's own comment still holds.

## 6 · Clanker — arm the composer, don't sit beside Stop

`#clanker-pill` renders inside the button column, one pointer-width from Stop:
persistent state filed among actions, adjacent to the control you click under
pressure. It is also the highest-contrast element in the panel (`#9a6700`, 700
weight, all caps) for a mode you set once and keep.

Claude Code's handling of the same problem is the model: permission mode is
never a control in the action row — it is a dim status line directly under the
input, coloured when it is the dangerous one, and the mode is a property of the
box you type into.

- `#clanker-pill` is deleted.
- `#prompt.clanker-armed` gets an amber border and a faintly warm ground.
- `#composer-hint` gains a `clanker-armed` variant: `⏵⏵ Clanker — no
  confirmations · /clanker to stop`, in the warning colour. It replaces the
  Enter hint while armed, so the hint row never doubles up.
- Off, none of this renders: no pill, no reserved space, no colour.

`/clanker` remains the toggle. It is already `availableWhileStreaming`, which is
correct — mid-turn is exactly when you want it, because that is when the agent
is asking.

## 7 · Thinking fold — say how much

`ThinkingGroup` renders a bare `▸ Thinking`, which gives no reason to open it
and no signal that reasoning was expensive. On a shared output budget, where
thinking and the answer draw on the same pool, that number is load-bearing.

- `AppMessage` gains `reasoningMs?: number`.
- `reducer.ts` stamps `Date.now()` into a `reasoningStartedAt` on the first
  `REASONING_TOKEN` for a message and writes `reasoningMs` when the first
  content `TOKEN` lands on that same message (the reasoning phase is over the
  moment prose starts).
- The label becomes `Thinking · 4.2 s` when the number is present, and stays
  `Thinking` when it is not — rehydrated sessions have no timing, because
  `PersistedRow` does not carry it and this plan does not change the persisted
  shape.

## 8 · The backend pair — one row that updates, not two that accumulate

`Starting backend, please wait…` and `Backend ready.` are two separate system
rows, and the first one stays in the transcript forever describing a wait that
finished seconds later.

Both already behave correctly with respect to provider — this is worth stating
because the preview's `· llama-server, 1 slot` suffix implied otherwise and has
been removed. The pair is emitted **only** from `runLocalProviderTurn`
(`ProviderTurn.ts:177`), the local-backend path, and only when `pool.acquire`
exceeds `BACKEND_START_NOTICE_MS` (500 ms). A cloud or API model never enters
that path, so neither row appears; a warm local pool skips them too, since
`READY` posts its reply only for conversations recorded in
`backendStartAnnouncedIds` (`reducer.ts:164`). Nothing needs to auto-change —
the rows are absent for cloud models rather than wrong, and no row should ever
claim a backend the turn is not using.

- `backendStartAnnouncedIds: Set<string>` becomes
  `backendStartRowIds: Map<convId, messageId>`.
- `READY` rewrites that row's content to `Backend ready.` instead of appending a
  second row. `BACKEND_DOWN` keeps clearing the entry, so a failure row is still
  the answer to the announcement and a later `READY` does not also reply.
- Net: one permanent stale row removed per cold start, and the surviving row
  says the current truth.

---

## Not in this pass

**Tagging auto-approved tool rows.** A write you confirmed and one Clanker waved
through (`ToolApprovalService.ts:84`) render identically. Fixing it properly
means threading an `autoApproved` flag from the approval service through
`ToolDispatch` and the `toolResult` bridge message into `ToolRow` — four files
and a bridge-shape change, for a signal the ON/OFF notice already gives at
turn granularity. Worth doing; not worth bundling into a layout pass.

**A first-use acceptance gate.** `toggleClanker` is synchronous
(`SlashCommandHandler.ts:40`, `sidebarWiring.ts:158`) and reached from the slash
handler, the webview router and the remote facade. A modal gate makes it async
and ripples through all three, and a remote `/clanker` from Telegram must not
block on a desktop dialog. Item 6 lands the visibility half of the problem
first; the gate needs its own small plan.

---

## Files touched

| File | Change |
| --- | --- |
| `webview-ui/src/components/Header.tsx` | one row, inline Forge mark, fixed-width budget track |
| `webview-ui/src/components/HistoryList.tsx` | drop `OpenRow` + section labels + open-tab props; Escape/outside-click close |
| `webview-ui/src/components/InputRow.tsx` | model into the action row; drop Queue; drop the pill; hint line; armed textarea |
| `webview-ui/src/components/StreamingStatus.tsx` | elapsed seconds |
| `webview-ui/src/components/ThinkingGroup.tsx` | duration in the label |
| `webview-ui/src/App.tsx` | `HistoryList` props; close-on-Escape wiring |
| `webview-ui/src/messageOps.ts` | `reasoningMs?: number` |
| `webview-ui/src/reducer.ts` | stamp the reasoning span; rewrite the backend row |
| `webview-ui/src/appState.ts` | `backendStartRowIds` map replaces the id set |
| `webview-ui/styles/layout.css` | header row; `margin-top: auto` anchor; dead logo CSS removed |
| `webview-ui/styles/sessions-panel.css` | overlay positioning; taller list |
| `webview-ui/styles/input.css` | horizontal action row; hint line; armed field; pill removed |

## Verification

`npm run ci` (type-check, lint, tests, production build) and `npm run package`.
Then a reload-and-look pass in the real sidebar, because none of the above is
covered by a test that renders pixels: open the flyout over a long transcript,
send during a stream and confirm the queued row is the only feedback, toggle
`/clanker` and confirm the field arms, and check a short conversation sits at
the bottom of the panel rather than the top.
