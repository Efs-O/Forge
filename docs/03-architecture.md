# 03 — Architecture

## Process model

```
VS Code Extension Host (Node)         spawns           llama-server (native)
┌───────────────────────────┐                          ┌──────────────────┐
│ extension.ts (activate)   │                          │  /v1/chat/...    │
│   ├─ SidebarProvider      │                          │  /v1/models      │
│   ├─ BackendController    │── child_process.spawn ──▶│  /health         │
│   │   └─ DirectBackend    │                          │                  │
│   ├─ OpenAIClient ────────│── HTTP (SSE) ───────────▶│                  │
│   ├─ ToolRegistry         │                          └──────────────────┘
│   └─ CheckpointStack      │
│                           │
│  Webview (separate JS)    │
│   ├─ Chat UI              │
│   └─ messageBridge ◀──────│
└───────────────────────────┘
```

## Repository layout

```
forge/
├── package.json                         Extension manifest + contributions
├── tsconfig.json                        strict mode
├── esbuild.config.mjs                   Bundling
├── .vscodeignore
├── README.md
├── CLAUDE.md  /  AGENTS.md              Agent rules
│
├── docs/                                This documentation set
│
├── config/
│   └── config.example.yaml              Schema seed (mirrors llamabridge/config/bridge.example.yaml)
│
├── src/
│   ├── extension.ts                     activate() / deactivate()
│   ├── sidebar/
│   │   ├── SidebarProvider.ts           WebviewViewProvider implementation
│   │   ├── messageBridge.ts             Typed host↔webview message protocol
│   │   └── webview/                     Built webview assets
│   ├── llm/
│   │   ├── OpenAIClient.ts              Streaming OpenAI-compat client
│   │   ├── SamplingMerge.ts             Per-model sampling precedence (TS port of bridge sampling.py)
│   │   ├── SystemPromptInjector.ts      TS port of bridge _merge_system_prompt_into_messages
│   │   ├── ThinkingMode.ts              chat_template_kwargs.enable_thinking handling
│   │   ├── StripTools.ts                Optional tool-stripping for fragile models
│   │   ├── types.ts                     ChatMessage, ToolCall, etc.
│   │   └── cancellation.ts              AbortController plumbing
│   ├── backend/
│   │   ├── BackendController.ts         Mode-agnostic interface
│   │   ├── DirectBackend.ts             Path A — spawns llama-server
│   │   ├── BridgeBackend.ts             Path B — connects to existing bridge
│   │   ├── LlamaServerArgs.ts           Compose CLI argv (TS port of bridge _compose_cmd)
│   │   └── HealthCheck.ts               GET /health, retry, ready-state
│   ├── config/
│   │   ├── ConfigLoader.ts              YAML loader + Zod validation
│   │   ├── schema.ts                    Zod schema for config.yaml
│   │   ├── settings.ts                  VS Code settings.json bindings
│   │   └── defaults.ts                  Built-in defaults
│   ├── templates/
│   │   ├── TemplateEngine.ts            Nunjucks wrapper (sandboxed)
│   │   └── builtin/                     Default Ask/Plan/Execute templates
│   ├── modes/
│   │   ├── AskMode.ts
│   │   ├── PlanMode.ts
│   │   └── ExecuteMode.ts               Agent loop
│   ├── tools/
│   │   ├── ToolRegistry.ts              Tool dispatch + capability/permission gate
│   │   ├── types.ts                     Tool, Capability, Permission interfaces
│   │   └── (per-tool implementations)   readFile.ts, searchCode.ts, listDirectory.ts, etc.
│   ├── checkpoint/
│   │   ├── CheckpointStack.ts           Per-turn snapshot + restore
│   │   └── KeepUndoCodeLens.ts          Inline Keep/Undo decorations
│   ├── search/
│   │   ├── TavilyProvider.ts
│   │   ├── BraveProvider.ts
│   │   └── WebFetcher.ts                Readability + Turndown + SSRF guard
│   └── util/
│       ├── logger.ts
│       └── tokens.ts                    Approx token counter
│
├── webview-ui/                          Webview source (separate build)
│   ├── index.html
│   ├── main.ts
│   ├── components/                      Mode selector, model picker, message list
│   └── styles.css
│
├── test/
│   ├── unit/                            vitest
│   └── integration/                     @vscode/test-electron
│
└── llamabridge/                         In-tree reference, removed before deploy
```

## Backend modes

Both modes implement the same `BackendController` interface; everything else in
the extension is mode-agnostic.

### Path A — Direct (default)

> **Note: conceptual lift, not a file import.** `src/llm/` and `src/backend/`
> are fresh TypeScript using Node primitives (`fetch`, `child_process.spawn`,
> `AbortController`). The Python files in `legacy/llamabridge/` are a
> read-only specification; they are removed before deploy.

- Extension spawns `llama-server` via `child_process.spawn` on activation (or on first model use).
- Composes CLI argv from `config.yaml` (`LlamaServerArgs.ts`, mirroring `llamabridge/continue_llamacpp_bridge/llama_server.py:_compose_cmd`).
- Polls `/health` every 1s, max 120s, until ready (mirrors bridge `is_up()` loop).
- Switch model: kill existing process (`SIGTERM` 5s grace, then `SIGKILL`), respawn with new `-m`.
- No Python required.

### Path B — Bridge (opt-in)

- Extension expects `continue-llamacpp-bridge` running on a user-configured URL (or spawns it if `bridge_command` set).
- Forge talks to the bridge over the same OpenAI-compatible HTTP protocol.
- Hot-swap, sampling-merge, system-prompt injection all happen bridge-side.
- For users who already run the bridge with Continue.

### Switching modes

Single config field:

```yaml
backend:
  mode: direct                         # or 'bridge'
```

The same `config.yaml` `models:` block works for both modes.

## llama-server detection (Direct mode)

Resolution order:

1. Read `backend.llama_server_binary` from `config.yaml`.
2. If `auto`: check `PATH` for `llama-server` / `llama-server.exe`.
3. If `auto` and not on PATH: check well-known locations:
   - Windows: `C:\Program Files*\Llamacpp\*\llama-server.exe`
   - macOS: `/opt/homebrew/bin/llama-server`, `/usr/local/bin/llama-server`
   - Linux: `/usr/local/bin/llama-server`, `/usr/bin/llama-server`
4. If still not found: surface a notification with a one-click "Open setup guide" linking to `https://github.com/ggerganov/llama.cpp`.

**No bundled binary pre-v1.0.** Bundling adds ~50MB per platform and ties Forge to llama.cpp release cadence.

## Lifecycle

### Activation
1. Read `config.yaml` (Zod-validated). Surface errors early.
2. Read `settings.json` (endpoint URL if Bridge mode, search API keys via `SecretStorage`).
3. Register `SidebarProvider` (`viewsContainers` + `views` contributions).
4. Lazy-init `BackendController` — do not start `llama-server` until first request (avoids blocking activation on a 30s model load).

### First user message
1. SidebarProvider posts user prompt → host via `messageBridge`.
2. Host calls `BackendController.start(activeModel)` if not ready.
3. `OpenAIClient.streamChat(...)` opens SSE.
4. Tokens streamed back to webview turn-by-turn.
5. `AbortController` ties to a "Stop" button in the webview.

### Tool call (Execute mode)
1. Model emits a tool call (native function-call format or structured JSON).
2. `ToolRegistry.dispatch(name, args, ctx)` — capability + permission gate first.
3. If write/exec category → confirmation UI before execution.
4. Result wrapped in `<TOOL_RESULT>` delimiters and added to the conversation.
5. Loop continues until model emits a non-tool response or iteration cap reached.

### Deactivation
1. Kill `llama-server` child process (Direct mode).
2. Dispose all `context.subscriptions`.
3. Persist conversation state to `workspaceState`.

## Concurrency

- One `llama-server` process per Forge session.
- One in-flight chat request at a time (cancel current before starting next).
- Multiple Forge windows = multiple `llama-server` processes, each on auto-picked free ports (avoids clashes with Continue or other sessions).

## Webview ↔ host messaging

Single typed bridge with discriminated unions:

```ts
type HostMessage =
  | { type: 'tokens';        sessionId: string; delta: string }
  | { type: 'tool-call';     sessionId: string; tool: string; args: unknown }
  | { type: 'tool-result';   sessionId: string; tool: string; result: unknown }
  | { type: 'done';          sessionId: string; reason: 'stop' | 'cancelled' | 'error' }
  | { type: 'error';         sessionId: string; message: string };

type WebviewMessage =
  | { type: 'send';          mode: Mode; modelId: string; content: string; context?: unknown }
  | { type: 'cancel';        sessionId: string }
  | { type: 'mode-change';   mode: Mode }
  | { type: 'tool-confirm';  callId: string; allow: boolean };
```

All cross-boundary messages flow through `messageBridge.ts`. No ad-hoc
`postMessage` in components.

## Resource disposal

Every owned resource gets pushed onto `context.subscriptions`:
- Webview view provider
- Tool registry
- Backend controller (calls `kill()` on dispose)
- File watchers (config.yaml hot-reload)
- Status bar items
- Commands

Failure to dispose = leaked listeners across reloads. Dispose discipline is
enforced by code review.

## Bridge-mode-specific notes

- Forge points at the bridge URL; the bridge owns the `llama-server` process.
- The same `config.yaml` `models:` schema is read by both — Forge for UI/model list, bridge for model lifecycle.
- If the user runs both Continue and Forge against the same bridge, models hot-swap based on whoever requested last. This is a known shared-bridge tradeoff.

## What we do NOT clone or fork

- `microsoft/vscode` — never. We use `@types/vscode` (npm dev dep).
- `microsoft/vscode-extension-samples` — read-only reference (specifically `webview-view-sample`).
- `continuedev/continue` — read for reference; do not lift code.
- `cline/cline` — read for agent loop patterns; do not lift code.

(Full external references: **[09-references.md](09-references.md)**.)
