# CLAUDE.md - Forge

## Stack
TypeScript + VS Code Extension API + esbuild. React webview. Nunjucks for
system-prompt templates. Three backend drivers: direct llama-server spawn,
Python bridge (opt-in), and native Ollama (local or Ollama cloud routing via
local daemon).

---

## What This Project Is
Forge is a VS Code sidebar AI coding assistant — single execute-style workflow,
no mode switching. Multi-tab conversations, tool-calling agent with per-action
confirmation gate, per-turn checkpoint/Keep/Undo for file changes, reasoning
token display, and image+file attachment support.

Backends: llama.cpp (GGUF, direct spawn), Python bridge
(continue-llamacpp-bridge, opt-in), and Ollama (local models + Ollama cloud
routing — auth handled by `ollama auth login`, not Forge). Optional web search
via Tavily / Brave (user-supplied key). Slash commands: `/review`, `/compact`,
`/undo`, `/keep`, `/newChat`, `/clearChat`, `/restartBackend`, `/unloadModel`,
`/reloadWindow`. No direct cloud LLM calls from Forge itself, ever.

The wedge: first-class llama.cpp control, tools tuned for local-model
reliability, zero-friction GGUF loading, optional search, hallucination-aware.

---

## Hard Stops - Never Do These
- No direct cloud LLM calls from Forge — Ollama cloud routing via local daemon is the only exception (auth stays in Ollama, not Forge)
- No telemetry, no auto-update pings, no analytics
- No hardcoded secrets, API keys, or OS paths
- No destructive commands (`rm -rf`, `DROP TABLE`, `git reset --hard`) without explicit user confirmation
- No duplicate implementations — grep before creating anything new
- No unsafe process management or force-killing unrelated processes without explicit approval
- No coupling to unrelated sibling projects (`llamabridge`, `hallumeter` stay decoupled — TS port, not Python dep; HalluMeter integration is opt-in)
- No tools with free-form `string` blob args (strict JSON schemas only)

---

## Investigation Hard Limit
- Max 5 investigation steps before stopping
- Stop and ask the user at step 3 if direction is unclear
- Never silently pivot to a different approach mid-investigation

---

## File Size Limit
- 350 LOC max per source file where practical
- Split into modules if exceeded
- Does NOT apply to `.md`, `.json`, `.yaml`, `.toml`, config files, or generated files

---

## Single Point of Truth

These are the canonical owners for each concern. Once implementation begins, do
not duplicate logic across modules — extend the listed file or split it.

### Sidebar / UI

| Concern                                    | Owner                                  |
| ------------------------------------------ | -------------------------------------- |
| Extension manifest + contributions         | `package.json`                         |
| Activation / deactivation                  | `src/extension.ts`                     |
| Webview lifecycle + message bridge entry   | `src/sidebar/SidebarProvider.ts`       |
| Agent loop + streaming lifecycle           | `src/sidebar/AgentLoop.ts`             |
| Tool call execution + result formatting    | `src/sidebar/ToolDispatch.ts`          |
| Conversation CRUD pure ops                 | `src/sidebar/ConversationOps.ts`       |
| Slash command dispatch + compact           | `src/sidebar/SlashCommandHandler.ts`   |
| Webview HTML builder                       | `src/sidebar/WebviewBuilder.ts`        |
| Multi-conversation session types + persist | `src/sidebar/sessionTypes.ts`          |
| First-run setup wizard                     | `src/sidebar/FirstRunWizard.ts`        |
| Keep/Undo CodeLens decorations             | `src/sidebar/KeepUndoCodeLens.ts`      |

### Backend

| Concern                                    | Owner                                  |
| ------------------------------------------ | -------------------------------------- |
| Mode-agnostic backend interface            | `src/backend/BackendController.ts`     |
| Multi-backend lifecycle + port allocation  | `src/backend/BackendPool.ts`           |
| Single-backend pool shim (bridge mode)     | `src/backend/SingleBackendPool.ts`     |
| Direct mode (llama-server spawn)           | `src/backend/DirectBackend.ts`         |
| Bridge mode (Python bridge connector)      | `src/backend/BridgeBackend.ts`         |
| llama-server CLI arg builder               | `src/backend/LlamaServerArgs.ts`       |
| Ollama endpoint normalization + health     | `src/backend/OllamaAdapter.ts`         |
| Backend health polling                     | `src/backend/HealthCheck.ts`           |
| GGUF file scanner                          | `src/backend/GgufScanner.ts`           |
| Model family heuristics                    | `src/backend/ModelHeuristics.ts`       |
| Runtime model capability detection         | `src/backend/ModelCapabilities.ts`     |

### LLM / Inference

| Concern                                    | Owner                                  |
| ------------------------------------------ | -------------------------------------- |
| Unified chat dispatch (llama.cpp + Ollama) | `src/llm/ChatClient.ts`               |
| Streaming OpenAI-compat client             | `src/llm/OpenAIClient.ts`              |
| Streaming Ollama native client             | `src/llm/OllamaNativeClient.ts`        |
| Request normalization (per-provider)       | `src/llm/RequestNormalizer.ts`         |
| Sampling parameter merge                   | `src/llm/SamplingMerge.ts`             |
| System-prompt injection                    | `src/llm/SystemPromptInjector.ts`      |
| Nunjucks template engine                   | `src/llm/TemplateEngine.ts`            |
| Thinking/channel tag stripper              | `src/llm/ThinkingChannelStripper.ts`   |
| HTML boilerplate stripper                  | `src/llm/HtmlDocumentBoilerplateStripper.ts` |

### Tools

| Concern                                    | Owner                                  |
| ------------------------------------------ | -------------------------------------- |
| Tool dispatch + capability/permission gate | `src/tools/ToolRegistry.ts`            |
| Tool registration entry point              | `src/tools/registerAllTools.ts`        |
| Built-in tool definitions                  | `src/tools/builtinTools.ts`            |
| File read/write tools                      | `src/tools/fileEditTools.ts`           |
| Directory listing tools                    | `src/tools/dirTools.ts`                |
| Terminal + headless exec tools             | `src/tools/execTools.ts`               |
| Exec child-process helpers                 | `src/tools/execHelpers.ts`             |
| Git tools (status, diff, commit)           | `src/tools/gitTools.ts`                |
| Search (Tavily / Brave)                    | `src/tools/searchTool.ts`              |
| URL fetch tool (SSRF-guarded)              | `src/tools/fetchTool.ts`               |
| LSP tools (go-to-def, refs, diagnostics)   | `src/tools/lspTools.ts`                |
| In-memory workspace memory tool            | `src/tools/memoryTools.ts`             |
| UX tools (show_diff, open_file)            | `src/tools/uxTools.ts`                 |
| Denylist (dangerous command filter)        | `src/tools/DenyList.ts`                |
| User confirmation gate                     | `src/tools/ConfirmationGate.ts`        |
| Tool strip (remove tools from request)     | `src/tools/StripTools.ts`              |
| Structured output / fallback tool parser   | `src/tools/StructuredOutputParser.ts`  |
| Tool call JSON-fence fallback converter    | `src/tools/ToolCallFallback.ts`        |

### Config

| Concern                                    | Owner                                  |
| ------------------------------------------ | -------------------------------------- |
| `config.yaml` schema (Zod)                 | `src/config/schema.ts`                 |
| Config load + validation                   | `src/config/ConfigLoader.ts`           |
| Bridge YAML config loader                  | `src/config/BridgeConfigLoader.ts`     |
| Config + model types                       | `src/config/types.ts`                  |
| User-facing config example                 | `config/config.example.yaml`           |

### VS Code Integration

| Concern                                    | Owner                                  |
| ------------------------------------------ | -------------------------------------- |
| Status bar (backend state indicator)       | `src/vscode/BackendStatusBar.ts`       |
| Native VS Code commands                    | `src/vscode/nativeCommands.ts`         |
| Code action provider (quick fixes)         | `src/vscode/codeActions.ts`            |
| Editor context collector                   | `src/vscode/editorContext.ts`          |
| Scratch document (markdown preview)        | `src/vscode/scratchDocuments.ts`       |

### Misc

| Concern                                    | Owner                                  |
| ------------------------------------------ | -------------------------------------- |
| Per-turn checkpoint stack                  | `src/checkpoint/CheckpointStack.ts`    |
| Structured logging                         | `src/util/logger.ts`                   |

Grep before adding any new constant, type, or function. If you find yourself
about to write logic that overlaps with an existing owner, extend the owner
instead.

---

## Architecture Rules
- Extension reads only its own `config.yaml` + VS Code `settings.json` — do not hardcode model paths or server args
- `llama-server` lifecycle stays isolated in `src/backend/DirectBackend.ts` (sole spawn site)
- All LLM dispatch goes through `src/llm/ChatClient.ts` — it routes to `OpenAIClient` or `OllamaNativeClient` based on provider
- Ollama cloud models route through the local Ollama daemon at `localhost:11434`; Forge sends no auth headers — auth is handled by `ollama auth login` on the user's machine
- Tool calls use strict JSON Schema — never expose a free-form `string` blob arg
- Network calls are limited to user-configured search/fetch endpoints — no other outbound traffic from Forge, ever
- API keys (Tavily, Brave) live in VS Code `SecretStorage`, never in `config.yaml` or git
- Webview ↔ host messages go through a single typed message bridge with discriminated unions (`src/sidebar/messageBridge.ts`)
- Per-turn checkpoints snapshot before any agent write; Keep/Undo decorations land before any write tool ships
- Keep dependencies minimal unless the user explicitly asks
- Prefer explicit config over hidden fallback behavior

---

## Code Quality Gates
```bash
npx tsc --noEmit
npx vitest run               # when tests exist
npm run package              # esbuild bundle smoke
```

Run these before finishing changes. CI must include all three once set up.

---

## TypeScript Rules
- `"strict": true` always — no `any` without an inline justification comment
- Validate config and request inputs at boundaries using Zod
- Prefer composition over inheritance
- Keep platform-specific process behavior explicit and well-contained
- Dispose VS Code resources (event subscriptions, providers, child processes) in `deactivate()` and via `context.subscriptions.push(...)`
- Use `AbortController` for cancellable operations (network, child process startup)
- Keep webview-side TS minimal; do not import Node modules into webview code

---

## No Fallbacks Unless Requested
- No silent error swallowing
- No hardcoded fallback values for user-configurable params
- No hidden behavior that masks invalid config
- Surface `llama-server` / bridge / Ollama errors to the user — never bury them in logs
- Show clear setup messages when `llama_server_binary` is missing (do not silently fail to start)

---

## Ask vs Proceed

| Situation                                               | Action  |
| ------------------------------------------------------- | ------- |
| Deleting any file                                       | Proceed |
| Adding a new dependency                                 | Proceed |
| Changing `config.yaml` schema in a breaking way         | Proceed |
| Changing public extension command/setting/view IDs      | Proceed |
| Adding a new tool to the catalog                        | Proceed |
| Adding a new outbound network endpoint                  | Proceed |
| Implementing work beyond current scope                  | Proceed |
| Bug fix within current scope                            | Proceed |
| Formatting / lint-style fixes                           | Proceed |
| Adding tests for existing behavior                      | Proceed |
| Internal refactor with no API/behavior change           | Proceed |
