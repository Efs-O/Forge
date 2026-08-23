# Forge — Recent Changes

## 0.13.2 — Open VSX release audit

- **The complete dependency audit is clean, including development tooling.**
  Upgraded Vitest and its V8 coverage provider to 4.1.11, esbuild to 0.28.2,
  and the transitive Vite toolchain to patched releases. The migration keeps
  the full test suite and coverage thresholds intact, updates the Vitest
  configuration to native ESM, and adapts a constructor test double to Vitest
  4's JavaScript constructor semantics. `npm audit` now reports zero
  vulnerabilities across production and development dependencies.
- **Production dependency audit is clean.** Updated `js-yaml` and the MCP SDK
  to patched releases, including their URL parsing and HTTP-server transitive
  dependencies. `npm audit --omit=dev` now reports zero vulnerabilities.
- **Delegation and privacy documentation matches the shipped behavior.** The
  README now distinguishes tool-free local-model delegates from read-only CLI
  delegates, removes the last reference to deleted CLI workers, and discloses
  that an explicitly invoked authenticated CLI uses its own network settings.
  The public tool-coverage matrix was regenerated from the current 48-tool
  catalog, removing retired worker tools and access columns.
- **The VSIX contains only release assets.** Removed a duplicate root logo,
  unused palette previews, and an unused SVG logo source from the package. The
  resulting archive contains no source, tests, local configuration, machine
  paths, source maps, or credential-shaped strings.
- **Forge's local-model wedge is clear at first glance.** The README now leads
  with first-class llama.cpp/GGUF control, local-model tool reliability, and
  reversible Keep/Undo checkpoints; Marketplace metadata uses the same
  concrete positioning. Open VSX is documented as an installation source, and
  development guidance uses the canonical `npm run ci` and `npm run package`
  gates.
- **The HTTP streaming smoke test no longer depends on a lucky ephemeral
  port.** Its loopback server retries ports that Fetch classifies as unsafe,
  eliminating a Windows CI failure that appeared only when the OS selected one
  of those otherwise-free ports.

## 0.13.1 — Shared-runtime reliability and worker removal

Supersedes 0.13.0, which was never published. The entries below marked *(found
in smoke testing)* came out of the manual two-window validation rather than the
automated suite — worth noting, because none of the 952 tests caught them.

- **Stop cancels the generation instead of killing the server** *(found in
  smoke testing)*. The Stop button aborted the request and then SIGTERM'd
  llama-server, so cancelling one generation cost a full model reload. Under a
  shared runtime it was worse: the owning window's Stop tore down the server a
  second window had borrowed, silently. Closing a tab took the same path.
  Aborting the request is what ends generation; backend teardown belongs to
  unload and eviction.
- **Re-borrowing no longer leaks the previous lease** *(found in smoke
  testing)*. Re-attaching to a restarted server took a second lease without
  releasing the first, leaving a lease file naming a live process — which
  blocked the owner from ever unloading. The exact failure shared leases exist
  to prevent, reached by a different route.
- **Window close no longer calls `stop()` on borrowed backends** *(found in
  smoke testing)*. It relied on `stop()` throwing into a swallowed catch, and
  skipped attachment-state cleanup. The borrower path is now explicit.
- **`forge.logLevel` is read again** *(found in smoke testing)*. The setting was
  contributed and shown in the settings UI but wired to nothing; only
  `config.yaml`'s `log_level` had any effect.
- **One llama-server output channel, not one per backend** *(found in smoke
  testing)*. Each backend created its own identically-named channel and nothing
  disposed them. Servers now announce themselves with a banner naming the model
  and port.
- **Repository instructions no longer name removed tools** *(found in smoke
  testing)*. `FORGE.md` still told the model to call `dispatch_workers`, costing
  a turn per delegation while it worked out the tool did not exist.

- **Releasing a borrowed model no longer strands the owner.** A runtime
  borrowed from another Forge window is now detached rather than stopped, and
  its lease is released even if detaching fails. Previously the release threw
  before cleanup, leaving a lease that blocked the owning window from ever
  unloading the model.
- **Leases from crashed windows are reclaimed.** Lease files record a PID and
  are discarded when that process is gone or the file is malformed, so a
  force-killed or crashed borrower no longer pins another window's VRAM
  indefinitely.
- **A borrowed runtime now counts as ready.** A window whose only backend was
  borrowed reported the model as loaded but not ready, so the status bar and
  the prompt gate disagreed about the same usable endpoint.
- **Worker dispatch is removed.** `dispatch_workers` and `list_worker_models`
  are gone, along with the coordinator/worker role split, its per-role
  permission and path policy, and the `Forge: Dispatch Workers` command.
  Delegation is unaffected: `ask_local_agent` still asks a second local model
  or an external CLI agent (Claude, Codex) for an opinion.
  `permissions.agents.cloud_workers` remains valid in `config.yaml` so existing
  configurations keep loading, but it grants nothing and Forge warns once at
  startup when it is present.

## 0.12.49 — Reliable resumes, Git batches, and repository instructions

- **Host-initiated turns always expose Stop.** The shared send pipeline now
  announces every accepted turn, including automatic post-compaction resumes,
  and a restored webview recovers busy conversations from the host session.
- **`git_stage` accepts multiple paths from one repository.** Repository
  selection uses one Git API snapshot and compares normalized roots instead of
  wrapper-object identity, while still rejecting genuinely cross-repository
  batches.
- **The context bar follows llama-server's occupied-token counter.** Completed
  local turns retain exact prompt-plus-completion usage, including thinking,
  instead of jumping back to a character estimate after the response lands.
- **`FORGE.md` is Forge's canonical repository instruction file.** It is
  preferred over `AGENTS.md`, resolved per nested repository, injected into
  Forge-native worker prompts, generated by `/initForge`, and—when
  `forge_instructions.auto_create` is enabled—created non-destructively in each
  Git repository VS Code discovers. `AGENTS.md` remains a compatibility
  fallback.

## 0.12.47 — Search, the round cap, and the tools that were quietly failing

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
- **The tool-round cap is configurable.** `max_tool_rounds` on `defaults`, a
  group, or a model — set it once on `defaults` to cover every model
  (built-in default 40, hard ceiling 400) replaces one constant that had to serve both a
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
- **`edit_file` can apply several edits in one call.** One edit per call is one
  *round* per edit, and rounds are the scarcest thing a turn has: 616 calls
  across recent sessions at an average of 1.62 tool calls per round, against a
  40-round budget. Pass `edits: [{old_str, new_str}, ...]` to change one file in
  a single call. Edits apply in order and all-or-nothing — a miss on any one of
  them leaves the file untouched rather than half-written.
- **`read_file` can number its lines.** `apply_line_edits` wants 1-based line
  numbers and verbatim `expected_lines`, but nothing could produce them: the
  only way to read a file returned bare text, so the model counted lines itself
  and failed **14 of the 19 times** it tried. `numbered: true` prefixes each
  line with its real number, ranged reads included.
- **`find_files` uses ripgrep, like `search_code`.** It used VS Code's indexed
  search service, which on a workspace held on a mapped network drive reported
  "no files match" for paths that plainly exist and are not ignored —
  `threejs-game-prompt/package*.json` among them, **16 failures in 42 calls** —
  while `search_code` was returning those very paths from the same root. Two
  file-matching tools backed by two engines could disagree about what the
  workspace contains. Now there is one engine, one root, one glob dialect.
- **A repeated tool name is no longer concatenated into an unknown one.** Only
  `arguments` is streamed in fragments; the name arrives whole. Appending every
  name delta assumed otherwise, so a provider that repeats it on each chunk
  produced `search_codesearch_code` — dispatched as an unknown tool, and a
  wasted round, every time (measured on `gemma4:31b-cloud`).
- **The `rm -rf` rule no longer refuses scoped deletes.** Its pattern ended in
  `-?[fF]` with the hyphen optional, so any bare "r" in a later filename
  satisfied it: `git rm -f README.md` was refused while `git rm -f notes.txt`
  was allowed. Recursion and force must now both be present as real flags,
  short or long. Every destructive form stays blocked, with tests to prove it.
- **The denylist covers the git commands that actually destroy work.** It
  blocked `git reset --hard` — which the reflog can undo — while allowing
  `git checkout -- .` and `git restore .`, which delete uncommitted changes with
  no confirmation and nothing to recover from. Also now refused: `git push` (any
  push is outward-facing, not only a forced one), `rebase`, `branch -d/-D`,
  `stash drop/clear`, `filter-branch`, and `reflog expire`. `git checkout
  <branch>`, `restore --staged`, `stash pop`, `add` and `commit` stay allowed —
  git itself refuses a checkout that would clobber local edits, so that is not
  the hazard, and a denylist that refuses ordinary work just teaches the agent
  to route around it.
- **A blocked command names the sanctioned route.** `delete_file` went uncalled
  across roughly three thousand tool calls while the agent reached for shell
  deletion and got a bare refusal. Refusals now say what to use instead.
- **`exec_command` stopped refusing ordinary one-liners.** The shell-operator
  guard matched `&&`, `;`, `|`, `` ` ``, `>`, `<` as *substrings* of an
  argument. Commands spawn with `shell: false`, so those characters reach the
  program verbatim and no shell ever sees them — the check prevented nothing and
  blocked a great deal: `node -e "for(let i=0;i<50;i++)console.log(i)"` was
  refused for containing `;` and `<`, which rules out most one-liners, every
  arrow function, every comparison, and every JS template literal. It now
  matches whole argument tokens, which is the thing actually worth catching:
  a model writing a shell line and handing over the pieces as argv.
- **`git_blame`, `git_show`, and `git_diff` on a path find the repository.**
  They spawned git in the workspace root while `git_status` and `git_log` went
  through VS Code's Git API, which *discovers* repositories. In a workspace
  whose repo sits one directory down, half the git tools worked and half
  answered `fatal: not a git repository`. All of them now resolve the repo —
  preferring the one containing the file, so several repos in one workspace
  blame the right one.
- **`go_to_definition` works on JavaScript again.** `executeDefinitionProvider`
  is typed as returning `Location[]`, but VS Code lets a provider answer with
  `LocationLink[]` — and the JS/TS server does. Reading `loc.range.start` on one
  threw `Cannot read properties of undefined (reading 'start')` on every JS
  file. `find_references` was never affected; its provider returns real
  Locations.
- **Session logs keep the reasoning on tool-call turns.** `ToolCallingLoop`
  deliberately carries each round's thinking onto the assistant message, and
  `SessionLogger` dropped it for exactly the turns that have `tool_calls` — the
  turns where the model decides what to do, and where it goes wrong. A 56-round
  session persisted thinking for one turn, the last. Reviewing why an agent
  spiralled meant reading its tool calls and guessing at the reasoning behind
  them. A turn that produced only reasoning is now kept too, instead of being
  skipped for having no content.
- **Language-intelligence tools open the file before asking about it.** VS Code
  providers analyse open documents; a file nobody has opened can report no
  symbols and no hover while plainly containing them — `get_document_symbols`
  answered "No symbols found." for a file whose `export class Game` a text
  search found on line 32. All the path-taking LSP tools now prime the document
  first, and a file that cannot be opened still reaches the provider rather
  than failing on the preparatory step.
- **`insert_code` and `replace_selection` name the file they wrote to.** Both
  target the *active editor* — whichever file the user has focused, which the
  model can neither choose nor inspect — and both replied "Inserted at line 0."
  with no indication of where. A write landing in an unrelated file left nothing
  in the transcript to show it. Their descriptions now say so plainly and point
  at `edit_file`, which takes a path.
- **`run_tests` and `run_build` take a `cwd`.** Both hardcoded the workspace
  root, so in a workspace holding several projects they looked for a
  `package.json` that was never there and failed with a bare ENOENT naming a
  path nobody had chosen. The error now names the directory it searched.
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
- Full record in `docs/archive/validation/POST_REFACTOR_AUDIT.md`, including what came back clean and
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
