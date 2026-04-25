# AGENTS.md - Forge

## Stack
TypeScript + VS Code Extension API + esbuild. Local llama.cpp backend (direct
spawn). Optional Python bridge mode (opt-in) for users who already run
`continue-llamacpp-bridge`.

---

## What This Project Is
Forge is a local-first VS Code extension providing a sidebar AI coding companion
backed by GGUF models via direct llama.cpp integration. Three modes: Ask, Plan,
Execute. Optional online search via Tavily / Brave (user-supplied API key). No
cloud LLM endpoints, ever.

The wedge: first-class llama.cpp control, tools tuned for local-model
reliability, zero-friction GGUF loading, optional search, hallucination-aware.

---

## Hard Stops - Never Do These
- No cloud LLM endpoints — Forge is local-only by design
- No telemetry, no auto-update pings, no analytics
- No hardcoded secrets, API keys, or OS paths
- No destructive commands (`rm -rf`, `DROP TABLE`, `git reset --hard`) without explicit user confirmation
- No duplicate implementations - grep before creating anything new
- No unsafe process management or force-killing unrelated processes without explicit approval
- No coupling to unrelated sibling projects (`llamabridge`, `hallumeter` stay decoupled — TS port, not Python dep; HalluMeter integration is opt-in)
- No tools with free-form `string` blob args (lesson from `llamabridge/CONTINUE_PATCH_NOTE.md` — strict JSON schemas only)

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

| Concern                                  | Owner                                              |
| ---------------------------------------- | -------------------------------------------------- |
| Extension manifest + contributions       | `package.json`                                     |
| Activation / deactivation                | `src/extension.ts`                                 |
| Webview lifecycle + message bridge entry | `src/sidebar/SidebarProvider.ts`                   |
| Mode-agnostic backend interface          | `src/backend/BackendController.ts`                 |
| Direct mode (llama-server spawn)         | `src/backend/DirectBackend.ts`                     |
| Bridge mode (Python bridge connector)    | `src/backend/BridgeBackend.ts`                     |
| Streaming OpenAI-compat client           | `src/llm/OpenAIClient.ts`                          |
| Sampling parameter merge                 | `src/llm/SamplingMerge.ts`                         |
| System-prompt injection                  | `src/llm/SystemPromptInjector.ts`                  |
| Tool dispatch + capability/permission gate | `src/tools/ToolRegistry.ts`                      |
| `config.yaml` schema (Zod)               | `src/config/schema.ts`                             |
| User-facing config example               | `config/config.example.yaml`                       |
| Per-turn checkpoint stack                | `src/checkpoint/CheckpointStack.ts`                |

Grep before adding any new constant, type, or function. If you find yourself
about to write logic that overlaps with an existing owner, extend the owner
instead.

---

## Architecture Rules
- Extension reads only its own `config.yaml` + VS Code `settings.json` — do not hardcode model paths or server args
- `llama-server` lifecycle stays isolated in `src/backend/DirectBackend.ts` (sole spawn site)
- OpenAI-compatible client behavior must remain consistent across Direct and Bridge modes
- Tool calls use strict JSON Schema — never expose a free-form `string` blob arg
- Network calls are limited to user-configured search/fetch endpoints — no other outbound traffic, ever
- API keys live in VS Code `SecretStorage`, never in `config.yaml` or git
- Webview ↔ host messages go through a single typed message bridge with discriminated unions
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
- Surface `llama-server` / bridge errors to the user — never bury them in logs
- Show clear setup messages when `llama_server_binary` is missing (do not silently fail to start)

---

## Ask vs Proceed

| Situation                                               | Action  |
| ------------------------------------------------------- | ------- |
| Deleting any file                                       | Ask     |
| Adding a new dependency                                 | Ask     |
| Changing `config.yaml` schema in a breaking way         | Ask     |
| Changing public extension command/setting/view IDs      | Ask     |
| Adding a new tool to the catalog                        | Ask     |
| Adding a new outbound network endpoint                  | Ask     |
| Implementing work beyond current scope                  | Ask     |
| Bug fix within current scope                            | Proceed |
| Formatting / lint-style fixes                           | Proceed |
| Adding tests for existing behavior                      | Proceed |
| Internal refactor with no API/behavior change           | Proceed |
