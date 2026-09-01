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
- **"Reply only" means reply only.** When the user says "reply only" (or
  "answer only", "just tell me"), do NOT call any tools — no builds, no
  commands, no file writes. Answer in chat and stop.
- Forge owns local model loading, pooling, checkpoints, permissions, and
  session persistence. Never claim a delegate ran unless `ask_local_agent`
  returned its result; respect all required confirmations.

## Plan docs

Every plan doc in `docs/plans/` must end with an "Acceptance criteria" section:
a checklist of invariants and edge cases, each mapped to a test or a named
validation step. Plans without one are incomplete; add the section before
implementation starts. (How to *follow* a recorded plan is delivered with the
plan itself, by `update_plan` — it is not repeated here.)

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

- **Process inspection:** `query_powershell` with
  `operation: list_processes, name: "llama-server*"` returns PID, name and
  command line; then `taskkill /PID <id> /F` via `exec_command` to kill one.
  (`wmic` also works today but reports itself deprecated and is being removed
  from Windows — do not reach for it.)

- **Never quote a path passed to `exec_command`.** Spaces are fine as-is
  (`C:\Program Files (x86)\Llamacpp\llama.cpp-b10673\llama-tokenize.exe`);
  quoting makes the quotes part of the program name → `missing_executable`.
  `llama-tokenize.exe` reads the prompt via `--stdin --show-count` (NOT `-` or a
  file arg — both are rejected); the count is the final stdout line
  `Total number of tokens: N`.
- **A tool call cut off at a byte limit is context pressure, not a path bug.**
  When an edit/write call is truncated at N bytes, the remaining context cannot
  hold the arguments — the fix is to split the write across several calls
  (write_file first chunk, then append_file), not to retry the same call.
  Distinct from the quoting ENOENT above: quoting = missing executable;
  truncation = context full.

- **Delegating with `ask_local_agent`:** prefer the CLI agents — they read the
  repo with their own tools and use no VRAM. A local (GGUF/Ollama) target
  spawns a *second* llama-server alongside the one serving you, so Forge asks
  the user before one runs; kill the spawned server afterwards (see process
  inspection above). Call `list_delegation_targets` for the current list.

- **The loaded extension host is the pre-reload build.** After building a
  VSIX (`npm run package`), the running session still executes the OLD code
  until the user installs + reloads. Re-ping only after a reload to test a fix.

- **Scripts (from `package.json`):** `npm test` (vitest), `npm run build`
  (dev), `npm run build:release`, `npm run type-check`, `npm run lint`,
  `npm run package` (build:release + `vsce package --no-dependencies`).
  `npm run ping-ollama-cloud` pings every Ollama `:cloud` model from
  `.forge/config.yaml` (fixed 2026-08-27 — previously pointed at the stale
  pre-F6 `bridge.yaml` and found zero models).

- **Test layout:** `test/unit` (fast, no models), `test/integration` (real
  processes/git, still hermetic), `test/live` (real model calls — skipped by
  default), `test/webview` (DOM). `npm test` runs the non-live set.

- **Session titles, and other rare lookups, are in `docs/WORKSPACE_FORENSICS.md`.**
  The current conversation's title is NOT in `.forge/sessions/*.jsonl` — those
  logs are still the forensic record of every tool call (dedupe rows before
  counting). Read that doc when you actually need one of these.

- **Attachments are persisted; pasted chat text is NOT.** Remote attachments
  (phone → Telegram/WhatsApp) are written to
  `.forge/remote-inbox/<conversationId>/<requestId>/N-<uuid>.<ext>` (0600,
  atomic temp→rename). Text/code files are stored as `.txt`, PDFs as extracted
  text (the original PDF binary is NOT kept); images keep their real extension.
  Retention follows `remote.attachments.retain_days` (currently `null` =
  forever). Local VS Code chat attachments are in-memory only (`AttachmentData`
  base64/utf8 through `buildUserContent`) — never written to disk. So: a file
  the user *attached* from the phone is on disk and readable back; text the user
  *pasted* into the chat lives only in the transcript. Don't call an attachment
  "pasted" — if you need to find or re-read an attached file, search
  `.forge/remote-inbox/` — it's on disk there.

- **Auto-compact fires only post-turn, on a completed turn or a recoverable
  context-exhaustion failure.** The fraction trigger needs the *server-reported*
  context ≥ `auto_compact.at` (0.85); the exhaustion trigger needs the last
  turn to have failed with a context-exhaustion reason. A turn that is 77% full
  and still generating is NOT a trigger — that is expected, not a bug. The
  `recoverableContextFailure` gate in `SendPipeline` is what lets a failed
  context-exhaustion turn reach the policy;
  without it, exhaustion failures bypassed auto-compact entirely.
