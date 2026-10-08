# Page-task tool fixes and restriction lift

Status: owner decisions recorded 2026-10-08; implementing.

## Why

Fifteen unattended single-page runs on 0.17.0 (pagoda, heptagon, minecraft × 5,
Strata `qwen3.8-flash-next-iq3_s`, `reasoning_effort: xhigh`) produced 457 tool
calls. Every call and result was read (per-run digests and three task reports in
the bench repo, `results/audit-0.17/`). About 22 calls were rejected; all but one
recovered within one or two calls. The one that did not killed its run.

Most of the lost time was the model building its own verification out of parts
the tools did not offer:

- 12 of 15 runs wrote a Node harness with hand-made DOM/WebGL stubs and spent
  many calls repairing the harness rather than the page (minecraft r1: 30 shell
  calls and 19 deletes; minecraft r2: 38 edits, most to the harness; heptagon r4
  and r5: several runs failing on the checker's own bugs). The page needed a real
  browser engine with numbers coming out of it, and `render_html_to_image`
  preview returns one screenshot plus errors only.
- A mismatched `edit_file` costs a `read_file` round before the retry (pagoda r1
  #54–55, r2 #13–15, r4 #10–12; minecraft r5 #15–16).
- Scratch files are deleted one call at a time (minecraft r1 #50–69).

The minecraft runs never used three.js (0/5, against 4/5 for the other harness
on the same model). Asked afterwards, the three sampled chats all named the
system prompt's "Never suggest cloud services or external APIs", the request's
single-file wording, and a belief that "do not open a browser" left them no way
to check a CDN load. Asked for an approach without building, the same model
chose three.js 4 of 5 times.

The owner's reading, adopted here: the prompt and the tool limits restrict the
model's capability. Phase 5 lifts every restriction that limits capability; the
security walls that never fired stay. Run it, and fix whatever breaks.

## Fixes

Ranked by what they cost in the runs.

### F1 — A malformed tool call must not end the turn

Pagoda r3 #3: `edit_file` arguments did not parse. `ToolDispatch.ts:193` records
the failure and returns `Error: malformed tool arguments (invalid JSON)`, but the
assistant message keeps the raw unparseable `function.arguments`. The next
request replays it; Strata's server parses tool-call arguments in the history and
answers HTTP 400 `Expecting value: line 1 column 31`. The turn ends with a
13 KB half-page and no answer. `truncationRecovery.ts:94` already replaces the
arguments with `'{}'` for the truncation case; the plain malformed case does not.

- On a parse failure, replace that call's `function.arguments` with `'{}'` in the
  message sent to the model. The session log keeps the raw string (it is the
  only forensic record).
- The tool result names the tool, the first 200 characters received, and the
  required fields, so the retry has something to correct against.
- Must not advance anything except the existing `ToolFailureTracker` record.

### F2 — `render_html_to_image` preview answers questions, not only "does it load"

Today: one screenshot after `wait_ms` (≤ 15 000), plus page errors and console
errors, scripts from three CDNs only. That cannot see motion (the pagoda r1
petals spawning away from the trees), cannot report a measured number (heptagon
bounce heights), and so the model builds a Node stub harness instead.

- `frames`: optional array of 1–4 capture times in ms (each ≤ 15 000, ascending),
  replacing `wait_ms` when given. Returns one image per frame, each labelled
  with its time. Vision-gated as today.
- Console output: return the page's `console.log/info/warn` lines too (not only
  errors), capped at 40 lines / 4 000 characters, oldest dropped with a count.
  This is the structured answer to "give me a number": the page logs it.
  No evaluate-an-expression argument — that is a free-form code blob (Hard Stops).
- `keys`: optional array of `{ key, hold_ms }` (≤ 8 entries, `key` from the
  Playwright key-name set, `hold_ms` ≤ 3 000) pressed in order after load and
  before the first frame. Enough to see that WASD moves a camera. Mouse and
  pointer lock stay out (headless pointer lock is not reliable; that is the
  browser tool family).
- Description: state that preview renders headless and opens no window (so
  "do not open a browser" does not forbid it), that it can load libraries from
  public hosts, and that `console.log` from the page is how to read a value out.

**Network (owner decision).** The three-CDN allowlist goes. Its purpose was to
stop a page sending data out, and with `web_fetch` unapproved (T7) and `shell`
able to `curl`, it no longer closes any route. What it still guards — and what
stays — is the local machine and LAN: Forge's control server (:8799), Strata
(:8090), the llama.cpp pool, the router and the dish.

- Preview may load any public `http(s)` URL.
- Blocked: loopback, private, link-local and unspecified addresses (v4 and v6),
  `file://`, and non-http(s) schemes.
- Design: Chrome's own DNS stays `MAP * ~NOTFOUND`, so Chrome never connects
  anywhere by itself. Every request the page makes goes through `context.route`,
  which fetches it from the extension host through `web_fetch`'s SSRF guard
  (resolve, check every address, connect to the checked address) and answers
  with `route.fulfill`. Checking the hostname and letting Chrome resolve it
  would be open to DNS rebinding (`localtest.me`, a public name pointing at
  127.0.0.1); fetching on Chrome's behalf is not.
- WebSockets are not routed and resolve nothing (DNS wall); an IP-literal
  WebSocket to loopback is covered by the live test below.
- WebRTC stays off (`--webrtc-ip-handling-policy=disable_non_proxied_udp`).
- Image mode is unchanged: no JavaScript, no network.
- CLAUDE.md's Architecture Rules paragraph on `render_html_to_image` is rewritten
  to this (CLAUDE.md is gitignored, so that edit is local); `RENDER_PREVIEW_PLAN.md`
  gets a pointer to this plan.

### F3 — `edit_file` mismatch returns the region it failed against

The mismatch message already names the closest line. Add the current text around
it (that line ±3, numbered, ≤ 1 200 characters) so the retry needs no
`read_file` round. Batch semantics stay all-or-nothing; the message keeps saying
which edits matched.

### F4 — `delete_file` takes several paths

Add `paths` (1–50) as an alternative to `path`; same trash default, same root
check, one result line per path, a missing path reported per line rather than
failing the rest. Minecraft r1 spent 19 calls on cleanup that is one call.

### F5 — Schema errors name the field that was wrong

- `update_plan` (minecraft r2 #1): the model sent an extra top-level `status`; the
  error talked only about item fields. Name the unexpected or missing key and its
  location.
- `append_file` / `edit_file` without `path` (pagoda r1 #13, r2 #5; minecraft r4
  #6): say "missing required `path`" first, then the accepted shapes.
- `edit_file` with `edits` sent as a string (pagoda r1 #19): reject, and report
  every problem in one message — "`edits` arrived as a string, not an array"
  (adding "and is not valid JSON" when it does not parse) alongside the missing
  `path`. In #19 the string was a garbled generation (`{"path", "new_str": …}`,
  no `old_str`), not a schema misunderstanding: the server's tool-call parser
  passed unparseable array text through as a string. Owner decision: no
  coercion — the string is not parseable, so coercion would not have rescued
  the call, and it was 1 of 457 calls, recovered on the next one.

### F6 — `render_html_to_image` `wait_ms` range in the error

Heptagon r1 #9 asked for 20 000. The schema states the range; the error should
restate it with the value received. One line.

## Restrictions

### As found

Everything the model was told or blocked from in the 15 runs, for the 16 tools
offered (`append_file delete_file edit_file find_files git_read list_directory
load_tool_group monitor_execution read_file read_tool_result
render_html_to_image search_code shell update_plan web_fetch write_file`).

System prompt (`config/templates/builtin/execute.njk`):

| # | Rule | Seen in the runs |
|---|---|---|
| P1 | "a local AI coding assistant running entirely on the user's machine" | primes offline; not named directly |
| P2 | "Never suggest cloud services or external APIs" | named by 3/3 asked chats as a reason to avoid a CDN library |
| P3 | "Use edit_file with exact old_str matches — never rewrite entire files" | scratch harnesses rewritten anyway |
| P4 | "Always read a file before editing it" | followed |
| P5 | "Search before creating anything new" | pagoda r1 searched an empty workspace for three.js |
| P6 | "Stop and ask after 3 failed attempts" | never reached |
| P7 | "considered a hypothesis twice… never three calls without progress" | no visible effect |
| P8 | shell: prefer dedicated read tools; destructive commands need approval | sed/grep/cat through the shell still common |
| P9 | "ALWAYS use tools to act — never describe or show code" | followed |
| P10 | "Be brief. Think only as long as the next action needs… do not draft full implementations in the thinking channel" | ignored: 40–50K characters of reasoning before the first write; conflicts with `reasoning_effort: xhigh` |
| P11 | Final answer ≤ 8 lines, no headings | followed |
| P12 | "run the narrowest check that proves it" before calling a change done | drives the Node stub harnesses |
| P13 | "Do not claim anything you have not seen in a tool result" | with "do not open a browser", why a CDN load felt unverifiable |

Task text, not Forge, and not changed here: "Do not open a browser" (bench
prompt) and the agent-bus footer "Do not call `ask_live_session`".

Tools and runtime:

| # | Restriction | Source | Seen in the runs |
|---|---|---|---|
| T1 | One write ≤ ~24 000 characters (window × (1 − `auto_compact.at`), floor 6 000, cap 24 000); larger content is write + append chunks | `writeChunking.ts` | every page built in 3–4 chunks |
| T2 | Thinking and answer share `max_tokens` 32 000 per request | Strata model entry | first requests spend ~17K output tokens, mostly thinking |
| T3 | `edit_file`: exact match, first occurrence, all-or-nothing, ≤ 40 edits | `editFileTool.ts` | 11 mismatches |
| T4 | Preview: one frame, `wait_ms` ≤ 15 000, console errors only, no input, three CDNs only, relative assets do not load | `renderHtml/` | 4 of 5 minecraft runs and pagoda r4/r5 never previewed |
| T5 | Preview description does not say it is headless / opens no window | `renderHtmlToImageTool.ts` | "do not open a browser" read as forbidding verification |
| T6 | `view_image` and all media tools in the lazy `media` group | `lazyToolGroups.ts` | never loaded |
| T7 | `web_search` off in the bench config; `web_fetch` stripped text, ≤ 30 000 chars | bench config, `fetchTool.ts` | never used |
| T8 | Browser tool family needs `permissions.browser.enabled` (off in the bench config, on in the main one) | config | n/a |
| T9 | Lazy groups `files`, `git`, `background`, `code_intel`, `editor_ui`, … hidden until loaded | `lazyToolGroups.ts` | none loaded |
| T10 | Shell deny list: recursive deletes, history-rewriting git, process kill, `Invoke-Expression` need approval; format, power, encoded PowerShell, download-piped-to-shell refused | `DenyList.ts` | never fired |
| T11 | `update_plan` ≤ 20 items × 200 characters, strict fields | `sessionTypes.ts` | one rejection |
| T12 | `delete_file` outside the workspace only under `extra_file_roots`; trash by default | `delete_file` | no effect |

### Owner decisions (2026-10-08)

| Row | After phase 5 |
|---|---|
| P1 | Rewritten: "a coding assistant running in the user's VS Code". No "local / entirely on the machine" priming. |
| P2 | Removed. |
| P3 | Removed. `edit_file` stays the tool for targeted changes; nothing forbids rewriting a file. |
| P4 | Narrowed (I4): "Read a file before editing it, unless its current content is already in a recent tool result." |
| P5 | Narrowed: "Before adding a function, module or dependency to an existing codebase, search for one that already does it." In an empty folder or a new standalone file there is nothing to search. |
| P6 | Removed. |
| P7 | Removed. |
| P8 | Tool preference removed. Approval for destructive commands stays (it is T10), enforced by the tool; the prompt only says not to run them unless asked (I1). |
| P9 | Reworded (I2): "Act with tools: write code into files with write_file or edit_file instead of showing it in your response." |
| P10 | Removed. |
| P11 | Kept. |
| P12 | Rewritten: verify the change before calling it done; for a page, `render_html_to_image` preview is the check. |
| P13 | Kept, with "a preview result is a tool result". |
| T1 | Removed. Write tools carry no size advice; `MAX_WRITE_CHUNK_CHARS` and `withWriteChunkLimit` are deleted. Truncation recovery stays as the reactive net: only after a write is actually cut off does the model get a character ceiling (TOOL_CALL_TRUNCATION_PLAN requires one), computed by `writeChunkLimit` without the 24 000 cap. |
| T2 | `max_tokens: 32000` removed from the Strata entry, bench and main config (main edited while no turn runs). Each request is sent the room left in the slot (`outputRoom`), which Forge already computes. |
| T3 | Contract unchanged; F3 returns the region on a miss. |
| T4 | F2: frames, console lines, keys; any public host; local network blocked. |
| T5 | F2 description: headless, no window, public libraries load. |
| T6 | Media group eager when the active model has vision. |
| T7 | `net.search` and `net.fetch` on in the bench config. Read-only web needs no approval (owner choice c). `web_fetch` `max_chars` maximum raised from 30 000 to 100 000; default stays 30 000. Search needs a Tavily or Brave key in SecretStorage; without one the tool reports that, as today. |
| T8 | Per-origin approval stays. On in the main config (it already is). Off in the bench (I8): the bench task forbids opening a browser and an unattended turn denies every approval, so listing the family there only costs tokens. |
| T9 | `files` and `background` groups eager. |
| T10 | Kept. |
| T11 | Kept; F5 error text. |
| T12 | Kept. |

### Injected-text fixes (owner decision 2026-10-08)

An audit of every text Forge injects into the model, beyond the P rules, found
these. All are applied in phase 5; the owner asked that they not be revisited.

| Row | Was | Now |
|---|---|---|
| I1 | P8 "destructive commands … always require the user's approval" while the unattended note says they "are denied, not sent for approval" — both reach every unattended turn | the template says only "unless the user asked for exactly that"; how it is enforced is the turn context's to say |
| I2 | P9 names only `write_file` | names `write_file` or `edit_file` (P9 row) |
| I3 | P12 example "a re-read of the edited lines" — the edit result already shows them | gone with the P12 rewrite |
| I4 | P4 "Always read a file before editing it" costs a round for a file just written | P4 row |
| I5 | search guidance in three places (P5, P16, P8), and P15 "search many files in one command" pointed at the shell | one line: "To locate code, use search_code: one call searches many files, so do not search file by file." then P5 |
| I6 | unattended note: "Remove files you created one by one with delete_file, several calls in one round" (minecraft r1's 19 deletes) | "To remove files you created, list them all in one delete_file call's paths."; the unattended denial text points at `delete_file` with `paths` |
| I7 | `PLAN_GUIDANCE` calls the model's own `update_plan` notes "the authoritative specification" and its summaries "navigation aids only" | "your record of this task's requirements"; keep it current with `update_plan` when an item is wrong; a requirement *the user gave* is not overridden by existing code |
| I8 | bench task "do not open a browser" vs the `lift` variant listing the browser family | browser stays off in the bench (T8 row) |
| I9 | loop-guard nudge: "so nobody has to be watching … Use your own judgment" | "The turn continues (N automatic retries left after this). Your next step can't be that same call again — you already have its result. Take the step that moves the task forward." |
| I10 | hardcoded fallback prompt (`SystemPromptInjector.ts`, used when the template cannot render) still carried P1, P2, P3, P6, P7 | the template's identity and kept rules |
| I11 | starter configs' `defaults.system_prompt` (new installs) repeated P10's "Be brief. Think only as long…", the shell-pointing search line and "re-read the edited lines" | removed; the template carries the rules |
| I12 | truncation recovery said "the file still ends up complete" twice after T1 | one ceiling sentence, then "write the first N characters or fewer, then append_file the rest, one call per chunk"; "Keep thinking short" stays (models without thinking kwargs still think on the retry) |

## Not in this plan

- Bench hygiene: `reset-forge-run.sh` does not restore `node_modules` on the
  page branch, so a run's `npm i` (pagoda r5) leaks into the next ones. That is a
  bench-repo fix, done before the reruns.
- Model choices the logs show but no tool causes: `sed` through the shell for
  edits, harnesses that delete their own failing assertion (minecraft r4 #22),
  claims with no measurement behind them (pagoda r2 "60 fps").

## Phases

1. F1 (+ its test). Smallest, and the only fix for a run-ending failure.
2. F3, F5, F6 — error-text changes, one commit.
3. F4.
4. F2 including the network change, the CLAUDE.md rule rewrite, and the live
   integration test extended.
5. Prompt rewrite (`execute.njk`), T1 removal, T6/T9 eager groups, T7 `max_chars`.
   Config: bench generator (`forge-bench-config.yaml` + `variant-cfg.mjs`, bench
   repo) for T2/T7/T8; main `.forge/config.yaml` for T2 only.

Each phase: `npm run ci`, `npm run package`, one commit on main. Bench rerun
(heptagon and minecraft × 2) after phase 4 and again after phase 5, so the tool
fixes and the restriction lift are measured apart.

## Files

| File | Change |
|---|---|
| `src/sidebar/ToolDispatch.ts` | F1: sanitize the replayed arguments, richer error |
| `src/tools/editFileTool.ts` | F3 region in the mismatch result; F5 field-named errors |
| delete tool owner in `src/tools/` | F4 `paths` |
| update_plan owner, append tool in `src/tools/` | F5 |
| `src/tools/renderHtmlToImageTool.ts`, `renderHtml/previewMode.ts`, `renderHtml/renderEngine.ts` | F2, F6, network routing through the SSRF guard |
| `src/tools/fetchTool.ts` (SSRF guard reused, `max_chars` max) | F2, T7 |
| `config/templates/builtin/execute.njk` | P1–P13, I1–I5 |
| `src/sidebar/turnContext.ts`, `src/sidebar/ToolApprovalService.ts`, `src/tools/planTools.ts`, `src/agent/ToolLoopGuard.ts`, `src/llm/SystemPromptInjector.ts`, `src/config/StarterConfig.ts` + `config/starter/*.yaml` | I6, I7, I9–I11 |
| `src/tools/writeChunking.ts`, `builtinTools.ts`, `src/agent/truncationRecovery.ts`, `src/sidebar/ModelTurn.ts` | T1 |
| `src/tools/lazyToolGroups.ts` | T6, T9 |
| `test/unit/…` per fix; `test/integration/RenderHtmlPreviewLive.test.ts` | live network checks |
| `CLAUDE.md` (local, gitignored), `docs/plans/RENDER_PREVIEW_PLAN.md` | preview network rule |
| `CHANGES.md` | one line per phase |

## State × lifecycle ledger

| Artifact | Create | Delete | Pause/disable | Crash mid-write | Owner-process death | TTL/expiry |
|---|---|---|---|---|---|---|
| Session-log assistant row holding the raw malformed arguments (F1) | appended when the call streams in, as today | deleted with the session log by the user only | none — logging has no off switch | partial JSONL line; `ArchivedSessions.readLogRows` already skips unparseable rows | row already flushed or lost with the process; no new state | none; logs live until the user removes them |
| Preview's ephemeral browser profile (F2, existing) | per preview call, OS temp dir | closed and removed at the end of the call, as today | preview not called = nothing created | launch failure removes the directory in the existing `finally` | orphaned temp directory left to the OS temp cleanup; no new behaviour | OS temp policy |
| Files removed by `delete_file paths` (F4) | n/a (deletes) | moved to the recycle bin per path, as single `path` does | permission `fs.delete: false` refuses the whole call before any path | paths before the failure are already trashed; the result lists which | same as above; the per-path result is not returned | recycle-bin policy |
| Config edits (T2, T7, T8) | written by hand while no turn runs | reverted by hand | n/a — the config is the switch | YAML write is one file save; a broken file fails config validation at load and is reported | n/a, nothing runs | none |

CI-enforced row: F1's sanitize — a unit test asserts that a malformed call never
reaches the outbound message with unparseable `arguments`, and that the session
log row keeps the raw string.

## Acceptance criteria

- A turn with a malformed tool call continues: the next request carries `'{}'`
  for that call, the model gets an error naming the tool and the required fields,
  and the session log still holds the raw arguments. Unit test, plus one live
  replay of the pagoda r3 shape on Strata.
- `edit_file` mismatch result includes the numbered current region (≤ 1 200
  characters); all-or-nothing behaviour unchanged.
- `delete_file` accepts `paths`, reports per path, and a missing path does not
  fail the others.
- `update_plan`, `append_file`, `edit_file` errors name the offending field;
  `render_html_to_image` restates the `wait_ms` range with the received value.
- Preview: `frames` returns one labelled image per time; console log lines come
  back capped; `keys` presses run before the first frame; description says
  headless / no window.
- Preview network, live test: a page loads three.js from a CDN and a script from
  a public non-CDN host; a local listener on 127.0.0.1 receives zero TCP
  connections and zero UDP datagrams from `fetch`, `<script>`, `<img>`, an
  IP-literal WebSocket and WebRTC; a public hostname resolving to 127.0.0.1 is
  refused; image mode still makes no request at all.
- Prompt: a unit test pins that the rendered system prompt contains none of the
  removed P-rule texts (P2, P3, P6, P7, P10, P8's tool preference) and does
  contain P4, P9, P11, P13.
- Injected texts: the template test pins the I1, I2, I4, I5 wording and the
  absence of "always require the user", "Search many files in one command" and
  "Always read a file"; the turn-context, loop-guard, plan-guidance and starter
  tests pin I6, I7, I9 and I11.
- Write tools: no size advice in any tool definition; a cut-off write still
  triggers truncation recovery with a character ceiling (existing tests kept).
- With vision on, the media tools are in the first request's tool list; `files`
  and `background` tools likewise.
- Bench reruns after phases 4 and 5: tool rejections, harness-repair calls,
  three.js use and grades reported against this audit's digests. No acceptance
  number is set in advance; the comparison is reported as measured.
