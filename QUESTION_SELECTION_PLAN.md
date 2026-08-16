# Plan — Interactive Question Selection for CLI Agents (FINDING-001)

**Status:** DRAFT for review — no code written yet.
**Goal:** Let a CLI agent (Claude Code / Codex) driving a Forge sidebar chat ask
the user a *structured, clickable* question (the `AskUserQuestion` picker) and
receive the chosen answer, instead of the current behaviour where the tool call
is silently swallowed and shown only as a `[claude: AskUserQuestion]` status line.

---

## 1. Root cause (verified in code)

Forge relays CLI agents one-way. Three facts from the source:

- `src/agents/adapters/claudeAdapter.ts` — a `tool_use` block only calls
  `ctx.emitStatus(...)`. There is no branch for `AskUserQuestion`, and no way to
  send anything *back* to the agent.
- `src/agents/types.ts` — `CliAgentEvent.kind` is `'text' | 'status'` only, and
  `CliParseContext` exposes just `emitText/emitStatus/setFinal/setError/setSessionId`.
  There is no "ask the user" callback and no return path.
- The Claude driver runs `claude -p <task> --output-format stream-json` — output
  is streamed and parsed, but **stdin is not used as a live control channel**, so
  the agent has nowhere to send an answer request and nowhere to read a reply.

So `AskUserQuestion` cannot render today because the plumbing for a **back-channel
(host → agent)** does not exist. This is a missing feature, not a regression.

Asymmetry worth noting up front:
- **Codex** already has a *bidirectional* JSON-RPC session
  (`src/agents/CodexAppServerSession.ts`, `request`/`notify` over stdio) — a
  back-channel exists; we mainly need to handle an elicitation/approval request.
- **Claude** is driven one-shot with one-way stdout parsing — it needs a genuine
  bidirectional transport (`--input-format stream-json` + reading control
  requests) to support elicitation. This is the harder leg.

---

## 2. Non-goals

- Not implementing question-selection for Forge's **native** (local-model) agent
  loop — that is a separate, easier feature (Forge owns the tool loop there).
- Not changing how CLI agents do file writes / permissions.
- Not adding free-form text tool args (Hard Stop: strict schemas only).

---

## 3. Design overview

Add a **request/response back-channel** for a single, well-typed interaction:
"agent asks a structured question → webview renders a picker → user's selection
is returned to the agent as the tool result."

```
CLI agent  ──AskUserQuestion(question,options)──▶  adapter detects it
   ▲                                                    │
   │ answer (tool_result)                               ▼
   │                                        CliParseContext.askUser(...)  (new)
   │                                                    │
   └──────────  driver writes reply to agent  ◀── messageBridge ──▶ webview picker
```

One question in flight at a time per conversation (mirrors the agent's blocking
tool call). A second concurrent question is an error.

---

## 4. Layer-by-layer changes

### 4.1 Shared types — `src/agents/types.ts`
- Add an `AgentQuestion` type: `{ id, questions: [{ header, question, options:[{label,description}], multiSelect }] }` (mirror the tool schema; strict, no free-form strings).
- Add `AgentQuestionAnswer`: `{ id, answers: Record<questionText, string[]> }`.
- Extend `CliParseContext` with `askUser(q: AgentQuestion): Promise<AgentQuestionAnswer>` (async — it suspends parsing until answered or cancelled).
- `CliAgentEvent`: add `kind: 'question'` carrying the `AgentQuestion` (so warm/one-shot drivers surface it uniformly through the existing `onEvent`).

### 4.2 Adapters
- **`claudeAdapter.ts`** — when a `tool_use` block has `name === 'AskUserQuestion'`, parse `input` into `AgentQuestion`, call `ctx.askUser(...)`, and (once resolved) write the answer back as a `tool_result` control message on the agent's stdin. Requires driving Claude with **bidirectional** stream-json (`--input-format stream-json`) — VERIFY the installed `claude` CLI version supports this and the control-request shape before building.
- **`codexAdapter.ts` / `CodexAppServerSession.ts`** — handle the Codex elicitation/approval request notification and reply via the existing `request`/`notify` channel. Codex already owns a back-channel, so this leg is smaller.

### 4.3 Driver / session — `CliAgentDriver.ts`, `CliAgentSession.ts`, `CliChatRunner.ts`
- Thread a new `onQuestion(q): Promise<answer>` callback from the sidebar down to `CliParseContext.askUser`.
- Manage the pending-question promise: resolve on answer, reject on cancel/turn-abort/timeout.

### 4.4 Message bridge — `src/sidebar/messageBridge.ts`
- Add two discriminated-union messages:
  - host → webview: `{ type: 'agentQuestion', id, question: AgentQuestion }`
  - webview → host: `{ type: 'agentQuestionAnswer', id, answer: AgentQuestionAnswer }`
  - plus `{ type: 'agentQuestionCancel', id }` for turn-abort teardown.

### 4.5 Webview — new React component
- `QuestionPicker` component: renders headers, options (single/multi-select), an
  "Other" free-text escape (matches the tool's built-in behaviour), and a submit.
- Wire into the conversation view; disable the chat input while a question is
  pending; send `agentQuestionAnswer` on submit.
- Keep webview-side TS minimal, no Node imports (architecture rule).

---

## 5. Concurrency, cancellation, limits
- **One pending question per conversation.** A second `askUser` while one is open
  → reject with a clear error surfaced to the agent.
- **Turn abort / stop** must reject the pending question and tear down the picker.
- **Timeout:** bound the wait (config-driven, explicit default) so a walked-away
  user doesn't wedge the agent forever; on timeout, return a cancellation to the
  agent so it can proceed or stop.
- **File-size:** the webview picker + bridge additions must respect the 350-LOC
  cap — new component in its own file; bridge stays within budget.

---

## 6. Degradation / fallback (no silent failure)
- If the installed CLI version does **not** support the back-channel, do **not**
  pretend: surface a clear status — *"This CLI agent version can't ask
  interactive questions; it will proceed with its own best judgement"* — and keep
  the current relay behaviour. (Aligns with "surface errors, no hidden fallback".)

---

## 7. Phasing (ship incrementally)
1. **Phase 1 — Codex.** It already has the bidirectional session, so it is the
   lower-risk first target and proves the bridge + webview picker end-to-end.
2. **Phase 2 — Claude.** Add bidirectional stream-json input; higher risk, gated
   on verifying CLI control-protocol support.
3. **Phase 3 — polish.** Timeout config, multi-select UX, "Other" text, a11y.

---

## 8. Testing
- Unit: adapter parses `AskUserQuestion` input → `AgentQuestion`; answer is
  written back in the correct control shape (fixture CLI, like the existing
  `CodexAppServerSession.test.ts` / `CliChatRunner.test.ts` fakes).
- Bridge: round-trip `agentQuestion` → `agentQuestionAnswer` discriminated unions.
- Webview DOM test: picker renders options, single/multi-select, submit emits the
  right message (pattern of `ModelManagerApp.dom.test.ts`).
- Cancellation: turn-abort rejects the pending question and clears the picker.

---

## 9. Open questions for the reviewer
1. **Scope:** CLI agents only, or also add a native `ask_user` tool for local
   models in the same pass? (Local is easier and arguably higher value.)
2. **Claude transport:** confirm the installed `claude` CLI supports bidirectional
   stream-json control requests for `AskUserQuestion`. If not, Phase 2 may need a
   different mechanism (or stays Codex-only for now).
3. **Timeout default:** what wait is sane before auto-cancelling a question?
4. **OWNERS.md:** new webview component + bridge messages need owner rows.

---

## 10. Risk summary
- **Biggest risk:** the Claude bidirectional back-channel — unverified CLI
  support; Phase 1 (Codex) de-risks the rest.
- **Second:** feeding a tool_result back mid-turn without corrupting the agent's
  own stream parsing.
- Everything else (bridge message, React picker) is standard and low-risk.
