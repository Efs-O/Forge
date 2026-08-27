# Live Context Metering + Warm CLI Delegation — Implementation Plan

Status: implemented (2026-08-15)

Two independent defects reported from a live Qwen-driven session:

1. The context bar and the HalluMeter bridge stay frozen for the whole agent
   turn. A turn that pulls 40k tokens of file content through 15 tool rounds
   shows the pre-turn number until the very end.
2. Every `ask_local_agent` call to a `provider: cli` target (Claude Code,
   Codex) spawns a brand-new CLI process. Observed cost: one review timed out
   at 30k tokens, the retry spent another 18k — both paying a full cold-start
   (system prompt + tool schemas + CLAUDE.md + MCP definitions) as a prompt
   cache miss.

---

## Part A — live context metering

### Cause

`postTokenBudget(true)` is called from the `finally` of `SidebarProvider.handleSend`
and from open/switch/reload paths only. Nothing recomputes while
`runToolCallingLoop` is running, so neither the `tokenBudget` webview message
nor `writeForgeBridge` fires mid-turn.

### Change

- `AgentLoop.setContextChangedListener(fn)` — a setter rather than an 18th
  constructor parameter. `SidebarProvider` registers it right after
  constructing the loop.
- `runAgentLoop` fires the listener once per tool round (after
  `toolDispatch.dispatch` returns, i.e. once `conv.messages` has actually
  grown) and once in `onDone`. Never per token: `estimateTokens` walks the
  whole transcript and `JSON.stringify`s every tool definition.
- `SidebarProvider.postTokenBudget` splits into a conversation-scoped
  `computeAndPublishBudget(conv, evaluateThresholds)`, with `postTokenBudget()`
  (active conversation) and `postTokenBudgetFor(convId)` (mid-turn) on top.
- Mid-turn ticks pass `evaluateThresholds = false`. Auto-compact must stay in
  the post-turn `finally`: `compact()` has a not-while-streaming guard, and
  compacting mid-turn would corrupt the transcript the loop is iterating.
- Ticks are throttled leading+trailing at 500 ms so a burst of parallel tool
  calls cannot stall the extension host on the synchronous `writeFileSync` in
  `writeForgeBridge`.
- A tick for a conversation that is not the active tab is dropped entirely —
  both the webview post and the bridge write. The bar only ever renders the
  active conversation, and letting a background turn write the bridge would
  make HalluMeter show a model the user is not looking at. Switching tabs
  already calls `postTokenBudget()`, so the number refreshes on arrival.

### Files

- `src/sidebar/AgentLoop.ts`
- `src/sidebar/SidebarProvider.ts`

---

## Part B — warm CLI delegation

### Cause

Forge already owns the right machinery: `CliSessionRegistry` keeps warm CLI
processes keyed by `(conversationId, modelName)` with LRU eviction and idle
disposal, and `AgentLoop` uses it for CLI *chat* via `runWarmCliChat`.

The delegation path never touches it. `LocalDelegationService` builds its own
bare `new CliAgentDriver()`, and `runCliDelegation` calls `driver.run({...})`
with no `sessionId` — a one-shot spawn that exits when the task ends.

Three separate costs stack up:

- **No reuse.** Each delegation is a cold process and a full cache miss.
- **A 120 s ceiling.** `DELEGATION_TIMEOUT_MS` is imposed on top of the
  driver's own 10-minute timeout. Two minutes is right for a local model
  answering a question and nowhere near enough for Claude to review a
  codebase, so a working run is aborted and everything it spent is discarded.
- **A lost session id on timeout.** `CliAgentSession.finishTurn` promotes
  `observedSessionId` to `confirmedId` only on a *completed* turn.
  `stopActiveProcess` (timeout/cancel/transport failure) drops it, so the next
  attempt cannot `--resume` and starts cold. Claude emits the session id in
  its init message, long before any timeout — the id is known and thrown away.

### Change

- Hoist `CliSessionRegistry` construction into `extension.ts` and inject the
  same instance into both `LocalDelegationService` and `SidebarProvider` →
  `AgentLoop`. One registry means `disposeConversation` cleans up delegation
  sessions along with chat sessions, and `max_cli_agents` caps the real total.
- Thread `conversationId` from `ToolDispatch` → `ToolHandlerContext` →
  `localAgentTool` → `LocalDelegationRequest`. Without a conversation there is
  nothing to key a warm session on.
- `runCliDelegation` uses `registry.run(...)` when both a registry and a
  conversation id are present, and keeps the one-shot `driver.run` fallback
  otherwise (tests, and any caller outside a conversation).
- **Key delegation sessions as `` `${resolvedId}#delegate` ``.** A delegation
  session runs `access: 'read'` (`--permission-mode plan`); a chat session with
  the same model in the same conversation runs `access: 'full'`
  (`bypassPermissions`). `CliSessionRegistry` applies `sessionOptions` only when
  it *creates* an entry, so sharing one key would silently hand a delegation
  the chat session's full write rights, or vice versa.
- Each delegation sends its complete self-contained task, not a resume-style
  follow-up: unlike chat turns, delegations are independent questions that
  happen to share a warm process.
- Split the timeout: `CLI_DELEGATION_TIMEOUT_MS = 600_000` for `provider: cli`
  targets, `DELEGATION_TIMEOUT_MS = 120_000` unchanged for everything else.
  The timeout error message reports whichever budget actually applied.
- `CliAgentSession.stopActiveProcess` promotes `observedSessionId` to
  `confirmedId` before resolving, so a timed-out or cancelled delegation can be
  resumed rather than restarted. The next `send` on that session spawns with
  `--resume <id>` and rejoins the warm transcript.

### Files

- `src/agents/CliAgentSession.ts`
- `src/delegation/CliDelegationRunner.ts`
- `src/delegation/LocalDelegationService.ts`
- `src/delegation/limits.ts`
- `src/tools/ToolRegistry.ts`
- `src/tools/localAgentTool.ts`
- `src/sidebar/ToolDispatch.ts`
- `src/sidebar/SidebarProvider.ts`
- `src/extension.ts`

---

## Validation

- `npm run type-check`
- `npm run lint`
- `npm test`
- `npm run build`
- New unit coverage: warm-session reuse across two delegations, the
  `#delegate` key namespace, the cli timeout split, session-id retention on a
  timed-out turn, and mid-turn budget ticks (per round, throttled, dropped for
  a non-active conversation).
