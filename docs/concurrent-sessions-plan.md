# Concurrent Sessions Plan — Tab-Switch Kills Active Stream

## Problem

Switching between chat tabs in Forge cancels the active agent/stream. Root cause:
there is **one shared `AgentLoop`** with **one `AbortController`**. `applySwitchConversation()`
calls `stopStreamingIfNeeded()` unconditionally, which aborts whatever is running.

Affects both llama.cpp and Ollama (same code path, provider-agnostic).

### Answers to open questions

| Question | Answer |
|---|---|
| Also present in Ollama? | Yes — same abort path, provider-agnostic |
| What happens if open tabs exceed `max_simultaneous_models: 4`? | BackendPool evicts the LRU *backend process* (llama.cpp server). Currently moot because streaming is killed on switch anyway; after fix, exceeding the pool limit will evict the LRU model server but the conversation messages already received are preserved in the host buffer |
| Re-opening the same 2 chats: new sessions? | No — `switchConversation` reuses `ConversationRuntime` by ID. The abort is the killer, not session creation |

### Reference: how other extensions handle this

- **Continue.dev**: `_sessionCache` Map keyed by sessionId; one AbortController per session; tab visibility never triggers abort
- **Copilot Chat**: `conversationId` indexing; WeakMap for conv→stream; abort only on tab close
- **Claude Code**: `disposeRequestMap(sessionId)` only on explicit close; switching returns to same controller state

All three share the same pattern: **per-session AbortControllers, decouple visibility from cancellation, tag all stream messages with conversationId**.

---

## Fix Overview

Six targeted changes. No new files needed.

```
messageBridge.ts   → add conversationId? to streaming message types + streaming? to SessionTabMeta
AgentLoop.ts       → per-conv AbortController Map; thread convId through all post() calls
SidebarProvider.ts → remove stopStreaming from switch; update submit guard; pass convId to cancel
sessionTypes.ts    → tabMetasFromSession passes streaming Set from AgentLoop
reducer.ts         → per-conv message buffers (messagesById Map); streaming/generating Sets
App.tsx            → route messages by conversationId; show spinner on streaming tabs
```

---

## Step-by-Step Todos

### 1 — `messageBridge.ts` — tag streaming messages + tab streaming flag

Add `conversationId?: string` to:
- `TokenMsg`, `ReasoningTokenMsg`, `DoneMsg`, `ErrorMsg`
- `ToolActivityMsg`, `FileDiffMsg`, `ConfirmRequestMsg`
- `CheckpointReadyMsg`, `CheckpointDismissedMsg`
- `BackendStartingMsg`, `BackendDownMsg`, `ReadyMsg`

Add `streaming?: boolean` to `SessionTabMeta`.

### 2 — `AgentLoop.ts` — per-conversation abort controllers

Replace:
```typescript
private activeBackend: BackendController | null = null;
private cancelController: AbortController | null = null;
private streamingSettled: Promise<void> | null = null;
private resolveStreamingSettled: (() => void) | null = null;
public streaming = false;
```
With:
```typescript
private readonly activeBackends = new Map<string, BackendController>();
private readonly cancelControllers = new Map<string, AbortController>();
private readonly streamingSettled = new Map<string, Promise<void>>();
private readonly resolveSettled = new Map<string, () => void>();
private readonly streamingConvIds = new Set<string>();
```

- `get streaming(): boolean` → `this.streamingConvIds.size > 0`
- `isStreamingConv(id: string): boolean` → `this.streamingConvIds.has(id)`
- `cancel(convId?: string)`: if convId abort that one; else abort all
- `stopStreamingIfNeeded(convId: string)`: await the per-conv promise
- `runTurn(conv, ...)`: create per-conv controller; capture `convId = conv.id`; use local `postC = (msg) => this.post({ ...msg, conversationId: convId })` for all streaming posts

### 3 — `SidebarProvider.ts` — decouple switch from abort

- `applySwitchConversation`: **remove** `stopStreamingIfNeeded()` call
- `applyCloseConversation`: keep `stopStreamingIfNeeded(id)` — closing IS intentional cancel
- `applyRestoreConversation`: keep `stopStreamingIfNeeded(id)` — restoring over a running conv is intentional
- `submitPrompt` guard: change from `this.agentLoop.streaming` to `this.agentLoop.isStreamingConv(activeId)` with a friendly error message
- `postSessionSync`: pass `streamingIds` from agentLoop so tabs get `streaming: true` flag

### 4 — `reducer.ts` — per-conversation message buffers

Replace flat `messages: AppMessage[]` with:
```typescript
messagesById: Record<string, AppMessage[]>;
streamingIds: Set<string>;
generatingIds: Set<string>;
```

Derive for render:
```typescript
messages        = state.messagesById[state.activeConversationId] ?? []
streaming       = state.streamingIds.has(state.activeConversationId)
generating      = state.generatingIds.has(state.activeConversationId)
```

All `TOKEN`, `REASONING_TOKEN`, `DONE`, `ERROR`, `TOOL_ACTIVITY`, `FILE_DIFF`,
`CHECKPOINT_READY`, `CHECKPOINT_DISMISSED` actions gain an optional `convId`.
If `convId` is absent or matches `activeConversationId`, write to active buffer (backward compat).
Otherwise write to `messagesById[convId]` without disturbing the view.

`SESSION_SYNC` populates `messagesById` for all tabs (not just active).

### 5 — `App.tsx` — route messages + tab streaming indicators

- Pass `conversationId` from message to dispatched action where present
- Pass `streaming` state into `TabStrip` so non-active streaming tabs show a dot/spinner
- `uiBusy` uses derived `generating` (for active conv only)

### 6 — `sessionTypes.ts` — tabMetasFromSession accepts streaming set

Update `tabMetasFromSession(sidebar, streamingIds?)` to stamp `streaming: true` on
tabs whose ID is in the set.

---

## What Does NOT Change

- `BackendPool` eviction logic — already correct LRU behaviour
- `max_simultaneous_models` naming — it controls server processes, not tabs; document this in config example
- Per-turn checkpoints — still fire per conv, no change needed
- Close/restore behaviour — still cancels the conv being removed

---

## Quality Gates

```bash
npx tsc --noEmit
npm run package
```
