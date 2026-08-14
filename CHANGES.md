# Forge — Recent Changes

## 0.12.31 — Shared runtimes, resilient Codex sessions, and queueing

- Added opt-in compatible llama.cpp runtime sharing between Forge VS Code windows.
- Hardened Codex app-server streaming and final-message recovery after command execution.
- Added queueing for a follow-up prompt while a conversation is streaming, preserving its tab.
- Corrected the control catalog so group-inherited Ollama and cloud providers report their
  actual provider and route.

## 0.12.29 — Config overhaul, Model Manager, CLI subscription agents

- Added schema-v2 config `groups` ("boards") that share tools, context, tool-call
  budgets, and sampling across model sets, layered under existing
  defaults/profiles/aliases, plus a v1→v2 config migrator (backup on write) and
  comment-preserving config writes.
- Added the Model Manager webview: scan a chosen directory, per-parameter tabs,
  model-path view, keyboard navigation, autosave, and delete-from-config or
  delete-from-disk (both confirmed).
- Added deterministic fuzzy worker resolution so short names like "gemma4"
  dispatch to the right model instead of failing on exact-name lookup.
- Added Claude Code and Codex as `provider: cli` agents that run through their own
  subscription login (no API key, no keys stored in Forge).
- Added persistent warm CLI sessions: one reused process per conversation tab
  (bounded pool with idle eviction) so only the first turn pays process startup,
  with checkpoint coverage and disposal on tab close and deactivate.
- Replaced eager whole-workspace CLI `Buffer` snapshots with bounded,
  disk-backed checkpoints, exact hash finalization, byte/file/free-space gates,
  per-conversation Keep/Undo stacks, and rollback preparation before
  `Backend ready`. Large workspaces are now refused safely instead of exhausting
  the VS Code extension host.
- Added the explicit `forge.checkpoint.externalCliEnabled` temporary opt-out.
  Disabling it skips external CLI workspace scans and clearly warns that those
  changes have no Forge Keep/Undo coverage; native Forge tools remain protected.
- Surfaced the CLI `Starting…`/`Backend ready`/disabled-rollback warning only on
  the first turn of a conversation, since later turns resume the warm session
  rather than restarting it; streaming state still updates every turn.

### Tool audit hardening

- Fixed `search_code` startup on current VS Code distributions by resolving the
  platform-specific `@vscode/ripgrep-universal` binary while retaining legacy
  layouts and the final `PATH` fallback.
- Expanded ripgrep startup errors with the resolved command and bundled
  candidates checked, making Extension Host layout failures actionable.
- Reworked `npm run test:local-tools` to derive all 48 native schemas from
  `registerAllTools.ts`, including structured-edit and delegation tools.
- Made strict tool-argument checks structural: reordered object keys now pass,
  while array order and changed values remain significant.
- Added explicit `--include-mcp` discovery, separate native/MCP origin labels,
  schema-emission-only reporting, and exact coordinator/worker catalog tests.
- Added isolated successful handler execution for every native tool group using
  temporary workspaces, repositories, controlled VS Code adapters, and mocked
  network providers; ordinary CI requires no model, GPU, secret, or internet.
- Added opt-in coordinator, worker, tool-free advisory, vision, and semantic
  capability checks with non-overwriting dated reports and a canonical
  native/MCP coverage matrix.
- Added an image-input preflight that explains how to select a vision model or
  configure a compatible llama.cpp `mmproj_path` instead of sending images to a
  text-only model.
- Fixed `run_tests` and `run_build` on Windows by resolving npm/npx shims to
  their adjacent Node CLI without enabling shell execution.

## 0.12.28 — Worker orchestration and safe structured editing

- Added bounded one- or two-worker coding orchestration across configured local
  and explicitly enabled cloud models.
- Added exact read/write worker access contracts, workspace discovery budgets,
  cancellation, backend admission, typed activity status, and coordinator
  review of verified changes.
- Added `apply_line_edits`, a strict atomic multi-edit tool with exact stale-line
  checks, bounded ordered operations, checkpoint integration, and exact worker
  path enforcement.
- Added opt-in local-agent consultation, MCP per-tool permission enforcement,
  non-evicting backend holds, and cancellation propagation.
- Hardened first-run configuration, Add Model preservation, permission gates,
  mutation metadata, and Keep/Undo coverage.
- Expanded the automated suite to 289 tests across 40 test files.

## Session JSONL Logging (HalluMeter + HalluScribe integration)

### What changed

Two files were added or modified to make Forge write conversation sessions to disk,
so that HalluMeter and HalluScribe can read them.

#### New file: `src/sidebar/SessionLogger.ts`

Writes one JSONL file per conversation to `~/.forge/sessions/<session-id>.jsonl`.

Called from `SidebarProvider` after every turn completes (in the `finally` block of `handleSend`).

**File format — one JSON object per line:**

```jsonl
{"type":"session_start","session_id":"<uuid>","title":"Chat","model":"gemma4-e4b-it-ud-q4kxl","timestamp_ms":1747000000000}
{"role":"user","content":"user message text","timestamp_ms":1747000000001}
{"role":"assistant","content":"assistant response text","timestamp_ms":1747000000002,"model":"gemma4-e4b-it-ud-q4kxl"}
{"role":"assistant","content":null,"tool_calls":[{"name":"read_file","input":{"path":"src/main.ts"}}],"timestamp_ms":1747000000003,"model":"gemma4-e4b-it-ud-q4kxl"}
{"role":"assistant","content":"Done.","reasoning":"I checked the file first.","timestamp_ms":1747000000004,"model":"gemma4-e4b-it-ud-q4kxl"}
```

Rules:

- First line is always `session_start` (written once when the first turn completes)
- `system` role messages are skipped
- Tool call messages have `content: null` and a `tool_calls` array
- `reasoning` field is included when the model produced a thinking block
- Messages are appended incrementally — each flush only writes new turns since last flush
- File is never overwritten, only appended

#### Modified file: `src/sidebar/SidebarProvider.ts`

- Imported `SessionLogger`
- Added `sessionLoggers: Map<string, SessionLogger>` field to the class
- Added `flushSessionLog(convId)` private method
- Called `this.flushSessionLog(conv.id)` in the `finally` block of `handleSend`, alongside `persistSession()` and `postTokenBudget()`

#### Also modified: `src/sidebar/SidebarProvider.ts` (HalluMeter bridge)

`postTokenBudget()` also writes `~/.forge/hallumeter-bridge.json` on every token budget update:

```json
{
  "model": "gemma4-e4b-it-ud-q4kxl",
  "used_tokens": 12500,
  "max_tokens": 98304,
  "timestamp_ms": 1747000000000
}
```

This is a single file, always overwritten. HalluMeter polls it every 5 seconds to show the live ring indicator.

Added imports at top of `SidebarProvider.ts`: `fs`, `os`, `path` from Node.js built-ins.
Added `writeForgeBridge()` standalone function before the class definition.

---

### What depends on this

| App         | What it reads                     | Purpose                                       |
| ----------- | --------------------------------- | --------------------------------------------- |
| HalluMeter  | `~/.forge/hallumeter-bridge.json` | Live context fill % for ring indicator        |
| HalluScribe | `~/.forge/sessions/*.jsonl`       | Nightly sweep → Gemma summarization → archive |

### Build note

After any change to `src/sidebar/SessionLogger.ts` or `src/sidebar/SidebarProvider.ts`,
rebuild and reinstall the `.vsix`:

```bash
npm run build
# then install the generated .vsix in VS Code
```
