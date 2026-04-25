# 07 — Roadmap

Single consolidated roadmap. All decisions from previous addenda merged.

---

## v0.1 — Chat MVP

Streaming chat against a running `llama-server`, end-to-end.

**Deliverables:**
- `package.json` with `viewsContainers` + `views` contributions; Activity Bar icon
- `extension.ts` activation skeleton
- `SidebarProvider.ts` rendering basic webview HTML
- Webview chat UI (input, message list, send, cancel, in-memory history)
- `OpenAIClient.ts` with SSE streaming + `AbortController` cancellation
- `BackendController` interface + `DirectBackend` (spawns `llama-server`)
- `LlamaServerArgs.ts` (TS port of bridge `_compose_cmd`)
- `HealthCheck.ts` (poll `/health` until ready)
- VS Code settings: `forge.endpoint`, `forge.defaultMode`, `forge.logLevel`
- Minimal `config.yaml` parsing (single model, no schema validation yet)
- README with setup steps
- llama-server detection (PATH → well-known locations → setup notification)

**Exit criteria:** type a prompt, see streamed tokens from local `llama-server`, cancel works.

---

## v0.2 — Editor Context

**Deliverables:**
- "Send selection" button + active-editor context capture
- `insert_at_cursor`-style action (manual, not yet a tool)
- "Replace selection" action
- Per-message buttons in webview: copy, insert, replace
- Webview-host typed message bridge (`messageBridge.ts`) finalised

**Exit criteria:** highlight code, send to model, get a response, insert/replace at cursor.

---

## v0.3 — Multi-model + GGUF Autodetect

**Deliverables:**
- Full `config.yaml` schema with Zod validation
- Multiple models registered; per-model params (`temperature`, `top_p`, `num_ctx`, etc.)
- Model picker dropdown in sidebar
- HF cache scan (`~/.cache/huggingface/hub`) + user-configured `model_dirs`
- Filename heuristics → suggested `llama_server_args` per family (Qwen3, Gemma 4, Llama, Mistral)
- Hot model switching (kill + respawn `llama-server`)
- First-run wizard if no `config.yaml` exists

**Exit criteria:** install Forge with no config, get GGUFs auto-detected, switch between them mid-session.

This is the headline wedge feature. Not delayed to v1.0.

---

## v0.4 — Plan Mode

**Deliverables:**
- Mode selector in sidebar wired (Ask | Plan | Execute, Execute disabled until v0.7)
- `PlanMode.ts` produces structured numbered steps
- Plan rendered as a checklist in the webview
- Plan-mode Nunjucks template with explicit "no execution, only plan" system prompt
- Plan-mode displays current context-fill % at generation time (precursor to HalluMeter integration)

**Exit criteria:** Plan mode produces a clear, step-by-step plan; user can copy or convert to Execute later.

---

## v0.5 — Read-only Tools + Search/Fetch

**Deliverables:**
- `ToolRegistry.ts` with capability + permission gating
- All 16 v0.5 tools implemented (see [05-tools.md](05-tools.md)):
  - Filesystem read: `read_file`, `list_directory`, `search_code`
  - LSP: `get_diagnostics`, `get_document_symbols`, `get_workspace_symbols`, `get_hover`, `go_to_definition`, `find_references`
  - VS Code UX: `show_diff`, `ask_user`, `show_notification`, `copy_to_clipboard`, `read_clipboard`, `open_url_in_browser`
  - Network: `web_search` (Tavily + Brave providers), `web_fetch` (Readability + Turndown + SSRF guard)
  - Memory: `remember`, `recall`, `list_memories`
- Native function-call path
- Structured-output fallback parser
- `<UNTRUSTED_CONTENT>` wrapping for fetched content
- Per-call confirmation UI for `net:fetch`, `net:http`
- "Forge: Set API Key" command palette entry

**Exit criteria:** Execute mode (read-only subset) completes a full agent loop using LSP + search to answer a real codebase question.

---

## v0.6 — Write Tools + Checkpoints + Keep/Undo

**Deliverables:**
- `CheckpointStack.ts` — per-turn snapshot of touched files
- `KeepUndoCodeLens.ts` — inline accept/reject decorations
- Write tools:
  - `write_file`, `create_directory`, `move_file`, `delete_file`
  - `replace_selection`, `insert_at_cursor`, `replace_in_file` (strict `old_str`/`new_str`)
  - `format_file`, `rename_symbol` (LSP), `insert_image`, `download_file`
- "Undo last turn" command (walks the checkpoint stack)
- Per-tool confirmation UI for `fs:write`, `fs:delete`

**Exit criteria:** agent edits files in Execute mode; user can Keep / Undo per edit; full turn rollback works.

---

## v0.7 — Execute Mode + Git + Terminal

**Deliverables:**
- `ExecuteMode.ts` with full agent loop (prompt → tool call → exec → result → repeat)
- Iteration cap (default 20) + token-budget guard
- Mode selector includes Execute (now active)
- Execution tools:
  - `run_terminal` (user-visible interactive)
  - `exec_command` (headless, captures stdout)
  - `run_tests`, `run_build`
- Allowlist + per-call confirmation for all `exec:*`
- Git tools (via `vscode.git` extension API):
  - Read: `git_status`, `git_log`, `git_diff`, `git_blame`, `git_show`
  - Write: `create_branch`, `switch_branch`, `stage`, `commit`
- Tool-call validator: detects partial/malformed args before dispatch, re-prompts
- `StripTools` fallback when a model repeatedly fails tool calls

**Exit criteria:** full Execute loop completes a small task end-to-end (e.g. "add a function, write a test, run it") with confirmations.

---

## v0.8 — YAML + Nunjucks Templates

**Deliverables:**
- Full `config.yaml` schema in production use
- Nunjucks `TemplateEngine.ts` (sandboxed)
- Default Ask/Plan/Execute templates shipped in `src/templates/builtin/`
- User-overridable templates in `<workspace>/.forge/templates/`
- Hot-reload on file save (re-validate, swap atomically, surface errors)
- Per-mode system prompt customization

**Exit criteria:** power user can rewrite Forge's prompts without touching extension code.

---

## v0.9 — Polish

**Deliverables:**
- Conversation persistence (per workspace via `workspaceState`)
- Token budget UI in sidebar (used / max with green/amber/red zones)
- Improved error surfacing (backend down, model not found, context overflow, SSRF rejection)
- Inline meter widget (HalluMeter integration via shared package — pending decision per [11-hallumeter.md](11-hallumeter.md))
- Settings UI improvements
- Keyboard shortcuts for common actions
- Comprehensive logging with redaction

**Exit criteria:** Forge feels production-quality for daily local-LLM coding work.

---

## v1.0 — Multi-modal + Read PDF + Marketplace

**Deliverables:**
- Vision tools (capability-gated):
  - `analyze_image` (multimodal model API call)
  - `insert_image` (already in v0.6)
- `read_pdf` via `pdf-parse`
- `http_request` with allowlist + per-call confirm
- Optional `read_notebook` / `run_notebook_cell`
- Marketplace publish (VS Code Marketplace + Open VSX for Cursor compatibility)
- README polish, screencasts, install docs
- License finalised (MIT or Apache 2.0)

**Exit criteria:** publishable extension with documented capabilities; first 100 installs.

---

## Post-v1.0

- **Cursor compatibility pass** — test against Cursor's VS Code fork; resolve any API divergences
- **`apply_patch`** — robust unified diff parser + fuzzy hunk apply (study aider's approach)
- **Optional `llama-server` binary bundling** — ~50MB per platform, revisited based on user feedback
- **Routing rules** in `config.yaml` — different models for different roles (coding, planning, vision)
- **MCP tool support** — register external tools via Model Context Protocol
- **Eval-data export** for HalluMeter local-model curve calibration (opt-in, anonymised)
- **`browser_automate`** via Playwright (separate stack)
- **`debug_session`** via DAP integration

---

## What's not on the roadmap (deliberate)

| Feature                            | Why not                                                       |
| ---------------------------------- | ------------------------------------------------------------- |
| Cloud LLM provider integration     | Wedge violation — Forge is local-only by design               |
| Telemetry / analytics              | Hard stop — see networking policy                             |
| Embedded Ollama                    | Ollama hides flags; Forge is direct-llama.cpp                 |
| Cross-extension chat history sync  | Out of scope; per-workspace persistence is enough             |
| Custom Forge marketplace UI        | VS Code marketplace is fine                                   |
| Web app version                    | Forge is a VS Code extension; no separate web target          |

---

## Roadmap discipline

- **Versions are scope cuts, not deadlines.** Ship when ready.
- **Read-only before write before exec** is non-negotiable.
- **Checkpoints land before any write tool.**
- **Per-call confirmation is the default**, session-allowlist is opt-in.
- **No version increments without** documenting tested behavior in this file.
