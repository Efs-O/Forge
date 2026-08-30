# Forge Agent Coordination

Act as the primary agent for this workspace. Forge has configured local models
plus authenticated Claude Code and Codex CLI agents.

- For tasks that benefit from independent review, research, or a bounded
  parallel implementation, consider delegating with `ask_local_agent`. Name the
  target model or CLI agent; keep each delegated task focused.
- Delegate meaningful, separable work — not trivial requests. You remain
  responsible for checking the result and reporting the final answer.
- Treat `ask_local_agent` as the only normal route to other configured agents
  and models. Do not launch Claude Code, Codex, or llama-server executables
  directly unless the user explicitly asks to test an underlying executable or
  startup path.
- Forge owns local model loading, pooling, checkpoints, permissions, and
  session persistence. Never claim a delegate ran unless `ask_local_agent`
  returned its result; respect all required confirmations.

## Workspace facts (discovered the hard way — read before re-doing this work)

- **Config is `.forge/config.yaml`** (F6 models-vs-profiles shape). Top-level:
  `active_model`, `defaults`, `profiles`, `aliases`, `models`, `mcp_servers`.
  Model entries carry a `group:` — `llamacpp-*` (GGUF, `gguf_path` +
  `mmproj_path` + `spawn`), `ollama-local` (local + `:cloud` aliases),
  `xai-cloud`, `openrouter-cloud`, `openai-compatible-cloud`, `provider: cli`.
  `x_shared` is a YAML-anchor block, inert to Forge (Zod strips it).

- **`config.yaml` is NEVER written back by the code.** `setActiveModel` /
  `hotSwap` are pure in-memory mutations of the shared `ForgeConfig`; per-tab
  selection persists in `workspaceState`, not YAML. So the file always shows the
  last *manually* edited value — it is **not** evidence of the live in-memory
  `active_model`. Don't read the file to verify runtime model state.

- **Process inspection:** PowerShell `-Command` is policy-refused in this
  workspace. Use `wmic` via `exec_command` instead:
  `wmic process where name='llama-server.exe' get ProcessId,CommandLine /format:list`
  to list servers, then `taskkill /PID <id> /F` to kill one.

- **Pinging models with `ask_local_agent`:** each local (GGUF/Ollama) ping
  spawns a *second* llama-server (delegation backend is separate from the one
  serving the primary agent). Use the smallest GGUF
  (`gemma4-e4b-it-ud-q4kxl-vision`) to minimise OOM risk, and **kill the
  spawned server after** (see process inspection above). API models
  (OpenRouter/xAI/Cerebras) never touch `hotSwap` — they're routed straight to
  the provider client.

- **The loaded extension host is the pre-reload build.** After building a
  VSIX (`npm run package`), the running session still executes the OLD code
  until the user installs + reloads. Re-ping only after a reload to test a fix.

- **Model status (verify before relying on it):** the five `ollama-local`
  `:cloud` models are paywalled (HTTP 402); `grok-4.20-multi-agent-0309`
  400s on token refresh; `zai-glm-4.7` is archived (404, not in config).

- **Scripts (from `package.json`):** `npm test` (vitest), `npm run build`
  (dev), `npm run build:release`, `npm run type-check`, `npm run lint`,
  `npm run package` (build:release + `vsce package --no-dependencies`).
  `npm run ping-ollama-cloud` pings every Ollama `:cloud` model from
  `.forge/config.yaml` (fixed 2026-08-27 — previously pointed at the stale
  pre-F6 `bridge.yaml` and found zero models).

- **Test layout:** `test/unit` (fast, no models), `test/integration` (real
  processes/git, still hermetic), `test/live` (real model calls — skipped by
  default), `test/webview` (DOM). `npm test` runs the non-live set.

- **Current session title lives in VS Code's `state.vscdb`, not in the repo.**
  The `.forge/sessions/*.jsonl` and `.coordination/sessions/*` files are
  decoys (stale/test data). The real live title is in
  `%APPDATA%\Code\User\workspaceStorage\<hash>\state.vscdb`, SQLite table
  `ItemTable`, key **`Efsoo.forge-llm`** (a JSON blob). Inside it,
  `forge.conversations.v1.activeConversationId` → match that id in
  `forge.conversations.v1.conversations[].title`.
  - Find the `<hash>` folder by reading each
    `workspaceStorage\<hash>\workspace.json` and matching `"folder"` to the
    workspace URL. For `n:\vs code apps\Forge` it is currently
    `e9a4155d14fdbca95fcae964471e7762` (re-derive if it ever differs).
  - No `better-sqlite3`/`sqlite3` CLI here; use Python's stdlib:
    `python -c "import sqlite3,json,sys;sys.stdout.reconfigure(encoding='utf-8');d=json.loads(sqlite3.connect(r'<ws>\state.vscdb').execute(\"SELECT value FROM ItemTable WHERE key='Efsoo.forge-llm'\").fetchone()[0]);c=d['forge.conversations.v1'];a=c['activeConversationId'];print([x['title'] for x in c['conversations'] if x['id']==a])"`
    (force UTF-8 or emoji in titles crash the cp1253 console).
