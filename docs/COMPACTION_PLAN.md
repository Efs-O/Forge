# Non-Destructive Compaction + Auto-Compact

**Branch:** `fix/nondestructive-compaction`
**Date:** 2026-08-15

`/compact` currently overwrites `conv.messages` with a two-message summary. That
array is simultaneously the model's context, the persisted record, and what the
sidebar renders — so compacting destroys the user's transcript to save the
model's context window.

Same failure shape as F5 (`slimPersistMessages` serving both disk and webview):
**one structure serving two consumers with different needs.**

Compaction has to shrink what the *model* sees — context is finite. It does not
have to shrink what the *user* keeps.

---

## T1 — Separate transcript from context

`conv.messages` stays the full transcript: rendered, persisted, never truncated
by compaction. A new optional field records the active context window.

```ts
/** Set by /compact. The model sees `summary` + messages.slice(fromIndex);
 *  the transcript itself is left whole. */
compaction?: { summary: string; fromIndex: number };
```

Applied in `AgentLoop.prepareMessages`, which the tool loop already calls on a
**copy** (`options.prepareMessages([...options.messages])`) and re-runs every
round — so the window holds for a long agentic turn without ever mutating the
stored conversation. The system-prompt injection already living there is the
precedent.

Persistence: one more optional field on the conversation schema. Backward
compatible by the same rule as F5 — older records simply lack it.

## T2 — Stop discarding tool results in the summary

`compact()` builds its transcript from `user`/`assistant` messages with string
content, so tool output never reaches the summarizer. Post-F5 those messages
exist and count against the budget, but their content is dropped — compaction
throws away what the agent actually learned.

Include tool results, truncated per message so a few large reads cannot
dominate the summary prompt.

## T3 — Auto-compact, opt-in

```yaml
auto_compact:
  enabled: false   # default off — user-selectable
  at: 0.85         # fraction of context that triggers it
```

Hook goes beside the existing 75% warning in `postTokenBudget()`, which only
runs post-turn, so `compact()`'s not-while-streaming guard is already satisfied.

**Not 0.95.** The summarization call sends the transcript, so it needs room to
run; at 95% there is none and auto-compact would fail exactly when it is needed.
0.85 leaves headroom. Default off regardless — automatic context surgery is the
user's call, even once it is non-destructive.

**Known limit:** `postTokenBudget()` runs only between turns, so a single turn
that fills the window mid-loop is not protected. More relevant now that
`MAX_TOOL_ROUNDS` is 500. A per-round budget check inside `ToolCallingLoop` is
the real fix and is deliberately out of scope here.

## T4 — Token budget on webview restore

`postTokenBudget()` has one caller: `submitPrompt`'s `finally`. It is not called
on `webviewReady`, and the webview initialises `tokenUsed` to 0 — so after a VS
Code restart the bar reads 0 until the next turn completes, and the 75% warning
cannot fire on the first turn. Call it in the `webviewReady` handler.

## T5 — Raise the sidebar tool-round cap

`MAX_TOOL_ROUNDS` 20 → 500 (user request; agent was hitting the ceiling
mid-task). Workers keep their own lower cap in `src/workers/limits.ts`.

---

## Order

1. T5 (already applied, uncommitted)
2. T1 transcript/context split
3. T2 tool results in summary
4. T3 auto-compact config + trigger
5. T4 restore-time budget
6. `npm run ci`
7. commit → merge to `main` → bump version → `npm run package` → install

## Acceptance

- `/compact` leaves `conv.messages` intact; sidebar scrollback survives
- model receives summary + tail, verified by a `prepareMessages` test
- tool results present in the summarized transcript
- `auto_compact.enabled: false` by default; nothing fires unless opted in
- token bar correct immediately after a window reload
- full CI green
