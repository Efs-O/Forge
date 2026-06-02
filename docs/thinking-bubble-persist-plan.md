# Plan: Persist Intermediate-Round Thinking Bubbles

**Status:** Draft — awaiting review  
**Scope:** 2 files, ~15 LOC changed

---

## Problem

In multi-round agent turns (model uses tools before answering), thinking bubbles from
intermediate rounds vanish as soon as the turn completes. Only the final round's bubble
survives.

**Root cause — two-part failure:**

1. `AgentLoop.ts`: when a round ends with tool calls, it pushes `{ role: 'assistant', content: null, tool_calls: [...] }` into `conv.messages`. The `rawReasoningContent` accumulated during that round is discarded — it never touches `conv.messages`.

2. `sessionTypes.ts / slimPersistMessages`: even if reasoning were on that message, the filter `typeof m.content === 'string'` would exclude it (`content` is `null` on tool-call messages).

After the full turn, `postSessionSync()` fires. The webview receives a `SESSION_SYNC` with the slim message list (user + final assistant only), which completely replaces the webview state. All intermediate thinking bubbles are wiped.

---

## What "sometimes it stays" means

When the model answers without using any tools (single round), the reasoning IS saved on
the final `conv.messages` assistant entry, survives `slimPersistMessages`, and persists
through `SESSION_SYNC`. Only multi-round (tool-using) turns are affected.

---

## Proposed Fix

### File 1 — `src/sidebar/AgentLoop.ts`

**Where:** the `if (toolCalls?.length)` branch, around line 345.

**Change:** attach accumulated `rawReasoningContent` to the tool-call message so it is
carried in `conv.messages`:

```ts
// Before
conv.messages.push({ role: 'assistant', content: null, tool_calls: toolCalls });

// After
conv.messages.push({
  role: 'assistant',
  content: null,
  tool_calls: toolCalls,
  ...(rawReasoningContent ? { reasoning: rawReasoningContent } : {}),
});
```

No change to the fallback-tool-call path (line ~364) — those are JSON-fence extracted
calls that never carry reasoning.

---

### File 2 — `src/sidebar/sessionTypes.ts`

Two functions need updating.

#### `slimPersistMessages` (line ~76)

Expand the filter to include tool-call assistant messages that carry reasoning.
Save them with `content: ''` (the schema already accepts empty strings — no schema
migration needed).

```ts
// Before
return messages
  .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
  .map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content as string,
    ...(typeof m.reasoning === 'string' && m.reasoning.length > 0 ? { reasoning: m.reasoning } : {}),
  }));

// After
return messages
  .filter((m) =>
    (m.role === 'user' || m.role === 'assistant') &&
    (typeof m.content === 'string' || (m.role === 'assistant' && typeof m.reasoning === 'string' && m.reasoning.length > 0))
  )
  .map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: typeof m.content === 'string' ? m.content : '',
    ...(typeof m.reasoning === 'string' && m.reasoning.length > 0 ? { reasoning: m.reasoning } : {}),
  }));
```

#### `chatMessagesFromSlim` (line ~86)

This function rebuilds `conv.messages` for the LLM context on session reload. Empty-content
assistant entries from intermediate thinking rounds must be excluded — sending `content: ''`
assistant turns to the model would be confusing and could break inference.

```ts
// Before
return slim.map((m) => ({
  role: m.role,
  content: m.content,
  ...(typeof m.reasoning === 'string' && m.reasoning.length > 0 ? { reasoning: m.reasoning } : {}),
}));

// After
return slim
  .filter((m) => m.role === 'user' || m.content !== '')  // skip display-only thinking entries
  .map((m) => ({
    role: m.role,
    content: m.content,
    ...(typeof m.reasoning === 'string' && m.reasoning.length > 0 ? { reasoning: m.reasoning } : {}),
  }));
```

---

## Why no other files need changing

| Component | Why untouched |
|---|---|
| `webview-ui/src/reducer.ts` | `SESSION_SYNC` already maps `reasoning: m.reasoning` — it just gets a non-empty value now |
| `src/sidebar/messageBridge.ts` | `messagesById` type is `content: string` — satisfied by `''` |
| `slimMsgSchema` (Zod) | `content: z.string()` already accepts `''` — no migration |
| Webview `Message.tsx` | Already renders thinking bubble when `reasoning` is truthy and `role === 'assistant'` |
| `SESSION_SYNC` id-preservation heuristic | Index alignment may drift (tool rows are still not in slim) causing some Message components to remount, resetting `thinkingOpen` to `false`. Bubbles will be **visible but collapsed** — acceptable, can be improved separately |

---

## Edge Cases

| Case | Outcome |
|---|---|
| Model reasons but produces no visible content, then calls a tool | Thinking bubble appears with round reasoning; no content bubble. Correct. |
| Model reasons AND produces visible content, then calls a tool | Both thinking bubble and content visible. Correct. |
| No reasoning on an intermediate round (model calls tool without thinking) | No change — nothing is added. Correct. |
| Session reloaded from disk | Intermediate thinking entries reconstructed by `chatMessagesFromSlim` then filtered out before LLM use. Thinking bubbles visible in UI. Correct. |
| `/compact` run after a multi-round turn | Compact operates on `conv.messages` which now has the reasoning on tool-call entries; the compact summary path in `SlashCommandHandler.ts` already appends reasoning to the compact text. No change needed. |

---

## What this does NOT fix

- Tool rows (the `tool` role messages) still disappear after SESSION_SYNC — that is a
  separate, lower-priority issue.
- If the user had a thinking bubble open (expanded) before SESSION_SYNC fires, it will
  close (React remount resets `thinkingOpen`). Fixing this requires stable id tracking
  across slim-message index shifts, which is out of scope here.

---

## Testing checklist

- [ ] Single-round turn: thinking bubble appears, persists after turn ends
- [ ] Multi-round turn (≥2 tool calls): each round's thinking bubble present after turn ends
- [ ] Multi-round turn: final answer bubble present
- [ ] Reload VS Code window: intermediate thinking bubbles still visible
- [ ] `chatMessagesFromSlim` does not include empty-content entries → verify by checking
      that follow-up messages in a tool-using conversation still get correct model replies
- [ ] `npx tsc --noEmit` passes
