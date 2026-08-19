# Forge — Recent Changes

## 0.12.47 — Search, the round cap, and where paths resolve

- **`search_code` stopped returning its own index instead of your code.** Three
  faults compounded. `.forge/` was never excluded, so the embeddings index — a
  verbatim copy of every indexed chunk — matched nearly any query; being a
  dot-directory it was also the *first* thing ripgrep reached. The exclude globs
  were root-anchored (`!.git/**`), so a monorepo's `subproject/.git/` and nested
  `node_modules/` were searched anyway, while `find_files` had always excluded
  them recursively. And the 50-line output budget was global, so whichever file
  came first spent all of it. Measured on a real workspace, a search for
  "pickup" returned fifty lines of index JSON and not one source file. Excludes
  are now recursive and cover `.forge/`, and a per-file snippet cap stops any
  single file from starving the rest.
- **`web_search` is reachable again — the permission, not the key, was hiding
  it.** `permissions.net.search` defaults to `false`, and once a `permissions`
  block exists at all those schema defaults are authoritative. Any config with
  an `exec` or `agents` group but no `net` group therefore filtered `web_search`
  (and `web_fetch`) out of the advertised tool list entirely, so the model
  truthfully reported having no web search tool — with a valid API key sitting
  in SecretStorage the whole time. Enable it with `permissions: { net: { search:
  true } }`.
- **Web search now authenticates the way Tavily documents.** The key moved from
  an `api_key` body field to an `Authorization: Bearer` header, and a 401 now
  says the key was *rejected* rather than implying it was missing. This is a
  cleanup, not a bug fix: verified against the live API, Tavily still accepts
  the undocumented body form, so a 401 from either form means the key itself is
  bad — check the key before suspecting the transport.
- **The context bar is calibrated against the tokenizer instead of a guess.**
  Chars-per-token was 4, the English-prose figure; measured against llama-server
  on 200,000 chars of real transcript, this workload runs 3.15. The system
  prompt was counted as a flat 200 tokens when the rendered template alone is
  659, because `injectSystemPrompt` builds it outside the message array the
  estimate walks. And reasoning was counted despite never being sent to the
  model — on an agentic turn that is a whole thinking budget of phantom tokens
  per round. The first two pushed the bar low and the third pushed it high, so
  each previous fix appeared to help and then drifted. This matters beyond the
  display: `auto_compact.at` and the 75% warning are fractions of this number,
  so a bar reading 0.85 was really nearer 0.95 of the window.
- **The Stop button survives an automatic compaction.** Compaction posts `done`
  in its `finally`, which clears the webview's streaming state, and the resume
  that follows is host-initiated — so it produced no `USER_SEND` either. The
  resumed turn generated with Stop hidden and only Send showing, leaving no way
  to cancel a turn that was still running. It looked random because auto-compact
  fires on a threshold, not on anything you did.
- **A refusal on one tab no longer disarms another.** `SendPipeline`'s guard
  errors were unaddressed, and the webview resolves an unaddressed message
  against the active tab — clearing *its* streaming state. A background
  conversation refusing a send hid the Stop button on whatever tab you were
  looking at.
- **Running out of tool rounds no longer throws your work away.** The loop
  *threw* at the cap, which discarded the turn's text and left nothing in the
  transcript to say the turn had been cut short — so the next request re-planned
  from a history that looked complete. It now returns, records the stop as an
  assistant turn, and keeps every edit the capped rounds landed.
- **The tool-round cap is configurable.** `max_tool_rounds` on a model or group
  (default 40, hard ceiling 400) replaces one constant that had to serve both a
  chat turn and a multi-file refactor. Measured on a real session: a turn that
  made 28 successful edits was killed at 40 rounds with the refactor half done.
  The cap's job is to bound a runaway loop, not to decide how big a task may be.
  Hitting it now says so, and names the setting.
- **Tool paths say what they resolve against.** Every `path`, `cwd`, and
  `include` resolves against the workspace root — but nothing said so, and a
  task pointed at a repository *nested* in the workspace ("you are working in
  .../Qwen testing/threejs-game-prompt") would ask for `BUGS.md` and get a bare
  ENOENT naming a path it never chose. The contract is now stated in the system
  prompt and in the tool schemas, including that `search_code` and `find_files`
  already return paths in the accepted form.
- **A search that finds nothing says why it might not have.** `search_code` is a
  literal search, so a regex like `\.heal\(` cannot match however much of it is
  in the file — and "No matches found" reported that identically to a term that
  is genuinely absent. The miss now names the search mode and the glob it used.

## 0.12.45 — Post-refactor audit fixes

- **A backend that was still starting no longer costs you thinking for the whole
  session.** The capability probe is cached per model, but a probe that failed
  degraded silently to name heuristics — and that degraded verdict was what got
  cached. A thinking-capable model raced at the first turn of a session ran the
  rest of it without thinking kwargs, warned you it did not support them, and
  only recovered on a config change. Degraded answers are now evicted so the next
  turn re-probes; concurrent turns still share one probe.
- **Workspaces whose paths contain `..config` or `..cache` work again.** The
  canonical containment check tested for a `..` prefix rather than a `..`
  segment, so any first path segment merely *beginning* with two dots read as
  traversal and every tool refused the file with "Path is outside the
  workspace". Containment now has one owner, `util/pathContainment.ts`.
- **The last turn before you close the window is recorded.** `last_used` writes
  were debounced 2s with nothing to flush them, so closing within that window
  lost the turn — the exact case the Model Manager's usage view exists to show.
  `deactivate()` now flushes.
- **CI evaluates the bundle, not just the types.** Circular-import and
  module-scope failures type-check clean and only appear on load, which is
  precisely what module reshuffling creates. `npm run ci` now loads the built
  bundle under a stubbed `vscode`.
- Full record in `POST_REFACTOR_AUDIT.md`, including what came back clean and
  the two items left for a decision (coverage-threshold enforcement, oversized
  docs).

## 0.12.44 — Compaction stops leaving the agent stale

- **Auto-compact can now resume the turn it interrupted.** Compaction used to
  end at a notice: the agent parked mid-task holding nothing but a summary, and
  you had to notice and re-prompt. When the previous turn was actually cut off —
  output limit, exhausted context, or the 40-tool-round cap — Forge now
  continues it. A turn that finished cleanly is left alone, `/compact` never
  resumes, and no more than two resumes happen without a prompt from you.
  Configurable as `auto_compact.resume` (default true).
- **A compaction no longer swallows a message sent while it runs.** The cut
  point was read *after* the summary came back, so anything you sent in those
  seconds ended up in neither the summary nor the retained tail — still visible
  in the chat, invisible to the model. The cut point is now taken before the
  summarization starts.
- **The conversation is marked busy while it summarizes.** Nothing was, so the
  input stayed live and a send could race the compaction; prompts are now queued
  and sent when it finishes.
- **Compaction keeps the last exchange verbatim.** The model used to be left
  with a paraphrase and nothing else. The last user turn is retained as-is
  (capped, so a large tool dump cannot be kept whole) and excluded from the
  summary.
- Added `query_powershell`: structured, read-only PowerShell inspection on
  Windows (workspace overview, location, directory listing, file hash). It takes
  named operations, never a raw script.

## 0.12.43 — The thinking pane follows its own reasoning

- **Fixed: an expanded thinking pane never followed the reasoning streaming into
  it.** The pane is its own scroll container (280px tall), so the message list's
  auto-scroll never reached it — past that height new text landed below the fold
  and stayed there. It now pins to the newest text, and stops following the
  moment you scroll up to read back.
- Auto-scroll no longer stalls mid-turn. Every token is a new message array, and
  the smooth scroll restarted its animation on each one without ever arriving.
  Streaming updates now jump instantly; settled ones keep the animation.

## 0.12.42 — Tool calls that outgrow the context no longer lose the turn

- A tool call cut off mid-arguments is now recognised as a truncation instead of
  a malformed call. Previously llama-server's HTTP 500 ("Failed to parse tool
  call arguments as JSON") was read as "this model cannot do native tool calls",
  so Forge stripped tools and re-sent the same oversized request — turning one
  lost call into a lost turn, and eventually disabling tool calling for the
  whole chat.
- On a truncation Forge now tells the model what actually happened — nothing was
  written, this is a size limit — and gives it a hard character ceiling for the
  retry. Two recoveries, then the turn fails with a clear `/compact` message
  rather than spinning.
- Recovery rounds disable thinking. Thinking and the answer share one output
  budget, so a retry that re-thinks starts with less room than the attempt that
  just failed.
- Added `append_file`, so a file too large for one call can be built across
  several. `write_file` and `append_file` both advertise the size ceiling.
- `max_tokens` is now derived from the room actually left in the slot rather
  than from a config value unrelated to it (4096 by default, or larger than the
  entire context where configured). It only ever lowers an explicit setting.
- **Fixed: the context bar and HalluMeter bridge over-reported every model with
  `n_parallel > 1`.** `--ctx-size` is the total across slots and `--parallel`
  divides it, so per-conversation context is `num_ctx / n_parallel`. A
  `n_parallel: 2` model now reads half what it did before — that is the correct
  figure, not a regression.
- A mid-stream SSE error frame is now surfaced instead of silently dropped. That
  class of failure used to end a turn with no message at all.

## 0.12.40 — Live context metering and warm CLI delegation

- The context bar and the HalluMeter bridge now update once per tool round
  during a turn instead of staying frozen until it ends. Ticks are throttled,
  scoped to the conversation, and never trigger auto-compact mid-turn.
- `ask_local_agent` to a `provider: cli` target (Claude Code, Codex) now reuses
  a warm CLI process for the conversation instead of spawning a cold one per
  call. A repeat review no longer re-pays the CLI's system prompt, tool
  schemas, and project instructions as a prompt-cache miss.
- Delegation and sidebar CLI chat now share one session registry, so
  `max_cli_agents` caps the real process count and closing a tab disposes both.
  Delegation sessions are keyed apart from chat sessions so a read-only review
  can never inherit a chat session's write permissions.
- Raised the delegation timeout to 10 minutes for `provider: cli` targets. The
  120s ceiling (unchanged for local models) was aborting working reviews and
  discarding everything they had spent.
- A timed-out or cancelled CLI turn now keeps its session id, so the next
  attempt resumes the existing session instead of starting cold.

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
