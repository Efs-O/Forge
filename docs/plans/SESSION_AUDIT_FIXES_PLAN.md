# Fix plan: findings from the 2026-10-05 Telegram-upgrade session audit

Source: `docs/reports/SESSION_AUDIT_TELEGRAM_UPGRADE_2026-10-05.md` (session `305fa3a7`, Strata
Flash-Next, 7 h 15 min, 1,242 tool calls). The § numbers below refer to that report.

The task itself succeeded. Each fix here removes a loss the report measured:

| Loss | Size | Phase |
|---|---|---|
| Compaction refused 7 times; 52 re-triggers suppressed | ~1 h at 85–97% context | 1 |
| `ask_live_session` 4,000-char loop | 26 failed calls, ~14 min | 2 |
| Idle at 02:35, waiting for a verdict that never wakes the turn | Owner had to intervene | 2 |
| Memory used in 4 of 12 sessions; key list shed in 4 of 6 compactions | Rules lost across compaction | 3 |
| FORGE.md over budget, memory rule cut mid-word, no marker | Every turn since 2026-10-04 | 3 |
| Summary Errors section grows 1.9K → 7.9K chars | 37% of the last summary | 4 |
| Misleading or bare tool refusals | ~15 calls, plus 32 `bash -c grep` | 5 |
| Session-log gaps that slowed the audit | Forensics | 6 |

## Ordering

Phases are independent unless noted, and each is one commit. Suggested order: 1 → 3 → 2 → 5 → 4 → 6.

- Phase 1 has the largest effect.
- Phase 3 is small and cheap.
- Phase 2b (verdict wake) is the only structural change. Review it on its own.
- Phase 4 changes the compaction prompt. Measure it against Phase 1's tokenizer numbers.

Not proposed: renaming tools to match training data. Only 2 calls used a non-existent tool name
(§7).

## Working arrangement

Another session is committing to `main` in the main worktree at the same time, so this plan is
implemented in isolation:

- **Branch and worktree:** branch `session-audit-fixes`, in its own worktree at
  `N:\vs code apps\Forge-audit-fixes`, created from `main`.
  - CLAUDE.md, AGENTS.md and FORGE.md are gitignored, so they are copied in by hand.
  - `node_modules` comes from `npm ci` in the worktree. Never junction it.
- **Commits:** one per phase, on the branch only. No push, no version bump, no VSIX.
- **CHANGES.md is not edited on the branch**, because the other session edits it on `main`. Each
  phase's commit message ends with the changelog line instead. The changelog entry is written when
  the branch is merged.
- **Roles:** an implementer (Codex) writes each phase and leaves it uncommitted. A supervisor
  (Claude) audits the diff and runs `npm run ci`, then either sends corrections or commits.
- **Test-first rule:** each named test must fail before the phase's source change. The implementer
  says in its report how it checked that, for example by stashing the source change and re-running
  the test.
- **Before each phase**, `git merge main` into the branch only if the phase touches a file that
  `main` changed since the branch point. Otherwise leave the merge for the end.

---

## Phase 1: compaction admission (report §4)

### What is wrong

`hostMaxChars = max(6000, P × 0.035 × 2.5)` (`src/sidebar/compactionBudget.ts`) converts a token
budget to characters at a fixed 2.5 chars per token. Strata measured 3.2–3.95. The required user-request
block is capped at a constant 12,000 chars, regardless of the budget. All 7 refusals would have been
admitted with real token counts.

### How the host block is measured today

`CompactionService.ts` builds the candidate state, then measures the host block in **characters**:

- `measureHost = compactionWindowChars(conv.messages, candidateWithSummary('')) − tailChars`;
- `shedOptionalHostFacts(optional, measureHost, budget.hostMaxChars)` sheds repo state, then memory
  keys, then the last reply;
- `refuseHostFacts` refuses when the host block still exceeds `hostMaxChars`.

The user block is capped separately by `USER_CONTEXT_MAX_CHARS = 12000` in
`src/sidebar/compactionUserContext.ts`, before any of this runs.

### Design

1. **Measure the real chars-per-token ratio once per attempt, and convert the token budget with
   it.** This keeps every character-based measure in place, which is the seam with the least churn.
   - Render the host block once, at its largest: after the repo snapshot, before shedding.
   - Count its tokens with the configured counter, then compute
     `ratio = hostChars / hostTokens`.
   - Then `hostMaxChars = max(6000, floor(P × 0.035 × ratio))`. Today the same formula is used with
     `COMPACTION_CHARS_PER_TOKEN = 2.5`.
   - One counter call per attempt. Strata measured 16–39 ms.
   - Clamp the ratio to [2.0, 5.0] so one odd sample cannot run away. Log a clamped value.
   - `compactionBudget()` gains an optional `charsPerToken` parameter. Only the host budget uses it
     in this phase; the source, summary and tail budgets keep 2.5. Say so in a comment, so that a
     later phase can widen it on purpose.
2. **Counter selection is explicit config, not probing.** Add an optional model and group field,
   `token_count: tokenize | count_tokens | estimate`:
   - `src/config/modelSchema.ts` holds the field.
   - `src/config/schema.ts` holds the provider cross-check, on the same pattern as `unload_path`
     (around line 259).
   - Provider rules:
     - `llamacpp` (direct): default `tokenize`, using `ServerTokenCounter` against the managed
       server.
     - `openai-compatible`: default `estimate`. It may set `tokenize` or `count_tokens`, which use
       the entry's `endpoint`.
     - Every other provider (ollama, cloud, cli): only `estimate` is valid. Any other value is a
       schema error that names the field.
   - Add `CountTokensCounter` in `src/search/TokenCounter.ts`, beside `ServerTokenCounter`, for
     `POST {endpoint}/v1/messages/count_tokens`. Strata answers it, while its `/tokenize` returns
     404. Read the response field name from a live call to `http://127.0.0.1:8090` before writing
     the parser, and put that sample in a test fixture. Do not guess it.
   - The counter reaches `CompactionService` through a new optional `CompactionDeps.countTokens`
     (`src/sidebar/compactionServiceTypes.ts`). The wiring site that builds the deps chooses the
     counter from the active model's config.
   - If a configured counter fails, the attempt is refused:
     - the notice names the endpoint and the error;
     - `onFailureCategory('budget-refusal')`.

     No silent fallback to `estimate`.
   - Update the `config.yaml` comments: the documented example, and the Strata entry, which sets
     `token_count: count_tokens`. **Do not edit `.forge/config.yaml`.** The owner does that after
     merge, and the plan's live check covers it.
3. **Size the user block from the budget.** The `USER_CONTEXT_MAX_CHARS` cap becomes a parameter of
   `renderCompactionUserMessages`:
   - its value is `max(4000, hostMaxChars − recordedActionsText.length)`;
   - the per-message cap stays at 4000.

   This still matters with a real ratio, for example on a manual `/compact` at 60K used tokens.
4. **Record the measurements in the attempt row.** `CompactionAttemptLogEntry` gains:
   - `hostChars` and `hostMaxChars`;
   - `charsPerToken` and `counter` (`tokenize`, `count_tokens` or `estimate`);
   - `components` (the same record that `refuseHostFacts` logs);
   - `shed` (string[]).

   These used to be found only in the exthost log. The fields are additive, and readers treat absent
   ones as legacy.

### Files (expected)

- `src/sidebar/compactionBudget.ts`
- `src/sidebar/CompactionService.ts`
- `src/sidebar/compactionServiceTypes.ts`
- `src/sidebar/compactionUserContext.ts`
- the attempt-row type and writer (grep `CompactionAttemptLogEntry`)
- `src/search/TokenCounter.ts`
- `src/config/modelSchema.ts`
- `src/config/schema.ts`
- the deps wiring site (grep `listMemoryKeys:` to find it)
- the bundled `config.yaml` template comments
- `docs/OWNERS.md`, only if a module is added (none is expected)

`CompactionService.ts` is near the 500-line cap. Run `npx eslint` on it before and after. If the
change pushes it over, move the measurement into a function in `compactionHostFit.ts`, which is
already the host-fit owner.

### Tests (written first)

1. **The session's real shape is admitted.**
   - Shape: 24 user messages, 40 recorded actions, 6 memory keys.
   - Point: 85% of a 200K context.
   - Counter: a fake `count_tokens` counter at 3.5 chars/token.
   - The attempt is admitted. It fails before the change.
2. **A manual `/compact` at 60K used** is admitted, and the user block is trimmed to its new cap.
3. **`estimate` changes nothing:** with `token_count: estimate`, `hostMaxChars` is exactly
   today's value.
4. **A counter that throws** gives a refused attempt whose notice names the endpoint, and no summary
   request is made.
5. **The ratio is clamped:** a ratio of 9.0 is used as 5.0, and the clamp is logged.
6. **The attempt row** carries every new field.
7. **Schema:** `token_count: count_tokens` on an `ollama` model is rejected, and on
   `openai-compatible` it is accepted.
8. **Response parser:** `CountTokensCounter` parses the recorded Strata fixture.

---

## Phase 2: messaging live sessions: Claude, Codex, Copilot (report §3, §8)

**Scope: all three live-session targets.** `ask_live_session` checks `MAX_QUESTION_CHARS`
before it routes, so every fix in Phase 2 applies to `claude`, `codex` and `copilot` alike. That
includes the limit, the error text, the description, the `forge.sh` wording and the verdict wake.
Only the *reason* for the ceiling is Codex-specific, and only on one path:

| Target / path | Transport | Hard ceiling |
|---|---|---|
| Codex via the `codex queue` path (deprecated pin, and the queue adapter) | argv; through cmd.exe for a `.cmd` shim | 8,191 minus ~550 of wrapper |
| Claude via `relayToClaude` | stdin to `claude -p` | none in practice |
| Claude as a joined or picked peer, Codex and Copilot as owned stand-ins | mesh / app-server protocol | none in practice |

One shared limit of 6,000 is therefore safe for every target. Do not add per-target limits. A model
cannot predict them, and the file-plus-path strategy is the real fix for all three.

### 2a: limits and wording

1. Raise `ask_live_session`'s `MAX_QUESTION_CHARS` from 4,000 to **6,000**
   (`src/tools/liveSessionTool.ts`).
   - The real ceiling is argv: `queueToCodex` passes the message on the command line, and a `.cmd`
     shim goes through cmd.exe's 8,191-char limit, with about 550 chars of wrapper.
   - Do **not** unify it with `forge.sh`'s 8,000. That limit is a different path.
2. Put the limit in the `question` field's description, with: "For a longer report, write it to a
   file and send the path plus at most 1,500 characters."
3. Rewrite the over-limit error. It should say:
   - not to trim and resend;
   - write the report to `.forge/tmp/<name>.md`;
   - send at most 1,500 characters plus the path;
   - the hard ceiling is N, and it overrides earlier instructions about report content (the same rule
     as truncation recovery in CLAUDE.md).
4. **`forge.sh send` says it will not wake the sender.**
   - The `send` line in the header comment of `src/agentBus/forge.sh` gets a short form of the
     message. Forge rewrites `~/.forge/agent-bus/forge.sh` from this file on every start.
   - The `/agent/message` route's response for a relay send (`to` is not `forge`) gets the full
     form: "Sent as exchange <id>. The verdict does NOT start a turn in your chat by itself. Use
     `ask_live_session` with `notify_on_answer`, or `wait` and then `read-verdict`." After 2b lands,
     the response says instead that the verdict will wake the chat when the send came from a Forge
     chat.
5. **The `manage_jobs` interval refusal points to `wait`.** The message is the Zod message in
   `src/jobs/jobSchema.ts` (`interval must be at least 15 minutes`). It adds: "To wait for a reply,
   use `wait` (ends early on a new message) or `ask_live_session` with `notify_on_answer`."
6. **The send result names who received the message.** On 2026-10-05 a Codex chat sent to
   `claude`, meaning the Claude that wrote this plan. The alias was held by a different Claude
   session (joined via `forge.sh join claude`), which answered instead. Nothing in the reply showed
   the mismatch.
   - The `/agent/message` relay response gains `delivered_to`, a single line such as
     `claude = session 7b39fb6e (joined, workspace n:\vs code apps\Forge)`.
   - It uses what the route already resolved: for a joined peer, `claude_session_id` and the attachment
     from `aliases.json`; for an owned session, its session id and workspace.
   - When a live stand-in answers for a dead joined peer, the result says `stand-in for <id>`.
   - `forge.sh send` prints the response as it already does, with no script change.
   - No new aliases or routing. The point is to make a wrong recipient visible at send time.

Dropped: a `report_path` field on `ask_live_session`. Writing a file plus sending the path already
works with no schema change. Revisit only if the new error text does not stop the loop.

Outside the code: the kickoff or supervisor prompt, whichever agent supervises (Codex, Claude or
Copilot), should ask for:

- each phase report in `.forge/tmp/phase-N-report.md`;
- a message of at most 1,500 chars, with the verdict needed, the CI result line and the path.

Record this as a short "supervisor message size" note in `docs/DELEGATION_UNBLOCK_PLAN.md`.
Forge does not enforce it.

**Commit 2a here.** 2b is a separate commit.

### 2b: a verdict for this chat's exchange starts a turn

Today a verdict travels this path:

`meshVerdictPoll` → `agentMeshSetup.onEvent` → `meshEventNotification` → `PendingHostActivity` →
`emitHostActivity`

It reaches only the remote-transport listeners. Telegram sees it; the model never does. And Forge
cannot tell which chat sent the exchange. The agent runs `forge.sh send` inside `exec_command`, and
the `/agent/message` route's existing `conversation_id` is the *target* Forge chat, not the sender.

Design:

1. **Forge tells its children which chat they run in.**
   - `exec_command` adds `FORGE_CONVERSATION_ID=<conversationId>` to the child environment when the
     call has a conversation (`context.conversationId`).
   - Forge sets it itself, after `validateExecEnv`, so a model-supplied `env` cannot set or override
     it. A model value under that name is refused like the other reserved names.
   - Background executions get it too.
2. **`forge.sh send` forwards it.** When `FORGE_CONVERSATION_ID` is set and valid (the same
   character class as `conversation_id`), `send` appends `origin_conversation=<id>` to the query.
   No new flag.
3. **The route records it.** `/agent/message` in `src/backend/agentRoutes.ts` accepts an optional
   `origin_conversation`:
   - validated by the same Zod rule as `conversation_id`;
   - accepted only with a relay `to` (not `forge`);
   - stored as `originConversation` on the exchange's `created` event in `exchanges.jsonl` (the
     exchange log owner, `src/agentMesh/exchangeLog.ts`).
4. **A wake pass, in every window, after the verdict pass in `meshVerdictPoll.pollOnce`.**
   - For each exchange that has a verdict event, whose `created` event has `originConversation`, and
     that has no `wake-<exchangeId>` event: if that conversation is open **in this window**,
     append `wake-<exchangeId>` under the exchange log's interprocess lock, with the same dedupe as
     `verdictEventId`. Then route the notice. If the append finds the event already present, skip.
   - This gives at-most-once delivery. A crash between append and route loses the wake. The
     Telegram notice and the retained verdict still exist, so nothing is lost but the nudge.
   - A conversation open in no window is never woken, and its wake event is never written. The pass
     re-checks on every poll until the verdict is acknowledged.
5. **Delivery reuses the `notify_on_answer` route.**
   - Use the same `route(text, conversationId, echoPrompt=false, internal=true)` callback that
     `subscribeLiveAnswerNotices` receives, wired where that one is wired.
   - Text:
     - "[Forge notice — not a message from the user] <from> answered exchange <id>.";
     - the retained verdict text, capped at 6,000 chars with a truncation line;
     - "Full text: `forge.sh read-verdict <your-name> <id>`; acknowledge with `ack-verdict` after
       reading.";
     - the same closing line as `formatLiveAnswerNotice`.
   - The route already starts a turn when the chat is idle, and queues the notice when the chat is
     busy. Verify that in a test; do not assume it.
6. **Unchanged:** the Telegram notice, exchanges with no `originConversation`, and
   `ask_live_session`.

### Files (expected)

2a:

- `src/tools/liveSessionTool.ts`
- `src/agentBus/forge.sh` (header)
- `src/backend/agentRoutes.ts` (response text)
- `src/jobs/jobSchema.ts`
- `docs/DELEGATION_UNBLOCK_PLAN.md`

2b:

- `src/tools/execTools.ts`
- `src/agentBus/forge.sh`
- `src/backend/agentRoutes.ts`
- `src/agentMesh/exchangeLog.ts`
- `src/vscode/meshVerdictPoll.ts`
- the wiring in `src/vscode/agentMeshSetup.ts`
- `src/agentBus/liveAnswerNotices.ts`, only if the formatter is shared

### Tests

2a:

1. **A worst-case 6,000-char question fits the cmd.exe limit.** A 6,000-char question of
   characters that cmd escapes, wrapped by `codexMessage()` and passed through
   `buildWindowsCmdShellInvocation`, stays under 8,191 chars.
2. **The new error is returned for every target.** A 6,001-char question gets the new error text,
   which contains a `.forge/tmp/` path suggestion and the number 6000. Parameterise the test over
   all three targets.
3. **The `send` header line** in `src/agentBus/forge.sh` contains "does not wake" (before 2b) or the
   matching 2b wording.
4. **The jobs refusal** contains `wait`.
4b. **`delivered_to`.**
    - A relay send to a joined `claude` peer returns `delivered_to` with that peer's
      `claude_session_id`.
    - A send to an owned `codex` session returns its session id.
    - A send that falls to a stand-in says `stand-in for`.

2b:

5. **The child environment carries the conversation id.** An `exec_command` child sees
   `FORGE_CONVERSATION_ID`, and a model-supplied `env.FORGE_CONVERSATION_ID` is refused.
6. **`origin_conversation` is recorded.** The route records it on `created` for a relay send, and
   rejects it on a `to=forge` send.
7. **Exactly one wake.** For a verdict for an exchange whose origin is conversation C, with C open in
   this window, two polls produce exactly one internal message in C. An exchange with no origin
   produces none.
8. **Two windows.** Window A does not have C open, so it writes no wake event. Window B has C open,
   so it delivers. Then A's next poll does nothing.
9. **The ledger CI row.** The wake event is already present when the pass runs (a simulated crash
   after the append), so nothing is delivered and nothing throws.
10. **Busy chat.** A wake for a mid-turn chat is queued, not dropped, through the real route
    callback or its contract test.

---

## Phase 3: memory and FORGE.md (report §8)

1. **Make the `memory` group eager.**
   - Remove it from `src/tools/lazyToolGroups.ts` and from `GROUP_PURPOSE` in
     `src/tools/toolGroupTools.ts`. It is 4 small schemas.
   - This changes the tool list, which costs one cold prefill at the first load after the upgrade.
     It does not recur.
   - Measure the schema tokens of the four tools (the same method as the tool-surface audit), and
     record the delta in the commit message.
   - If any code checks the memory tools' group membership, for example a "load memory first" hint,
     update it.
2. **Never shed memory keys.**
   - In `src/sidebar/compactionHostFit.ts`, remove the memory-keys step from
     `shedOptionalHostFacts`, and move `memoryKeys` from `OptionalHostFacts` to the required facts.
   - They are already bounded: 40 keys (`COMPACTION_MEMORY_KEYS_MAX`), each at most
     `COMPACTION_MEMORY_KEY_MAX_CHARS`, via `boundMemoryKeys`.
   - Add `memory keys` to the components that `refuseHostFacts` reports.
   - The `remember` description ("Keys are listed back to you after every compaction") becomes true.
3. **Raise `MAX_INSTRUCTION_BYTES` from 25,000 to 32,000** (`src/llm/forgeInstructionsChain.ts`),
   about +2K tokens.
4. **Mark a truncated lone file.** The lone-file path (`present.length === 1`) clamps without
   `TRUNCATION_MARKER`. Clamp to `maxBytes − byteLength(TRUNCATION_MARKER)` and append the marker,
   as the multi-file path already does.
5. **Warn at 90% of the budget.** `ForgeInstructionsLoader.reportBudget` warns once per load when
   the rendered instructions pass 90% of `MAX_INSTRUCTION_BYTES`, naming the file and its size.
   FORGE.md is gitignored, so this runtime warning is the only check. There is no CI size test.

### Tests

1. **The memory tools are eager.** They are in the eager list, and `load_tool_group`'s enum and
   description no longer name `memory`.
2. **Memory keys survive shedding.** With memory keys present and the host block over budget, repo
   state and the last reply are shed, and the keys are not.
3. **The lone-file marker.** A lone FORGE.md over 32,000 bytes renders ending with the marker, and
   the total stays within 32,000 bytes. Under the budget, there is no marker.
4. **The 90% warning.** A file at 29,000 bytes produces the warning. One at 28,000 does not.
5. **Existing tests stay true.** Grep the tests that assert memory is lazy, or that memory keys are
   shed second, and update them. Each update must be justified in the report as an intended change
   of behaviour.

---

## Phase 4: compaction summary content (report §8, "Compaction summaries")

The summaries were adequate (no drift after 6 compactions), but they grew from 9.2K to 21.4K chars.
Errors alone added 6K.

Changes to the summarizer prompt (`src/sidebar/compactionPrompt.ts`):

1. **Errors:**
   - list unresolved items;
   - list each lesson once, as a rule (for example "booleans are lowercase `true`");
   - give no history of fixed typos;
   - fold a lesson already in the previous summary into the same rule; do not repeat it.
2. **A limit that was hit goes under Constraints**, with its number and the tool it belongs to.
3. **Drop a time-bound constraint once its time has passed.** The prompt gets the current local
   time (formatted by the caller, injectable for tests) and the rule.
4. **After the resume, refresh the plan.** The note appended after the summary
   (`lazyGroupSummaryNote` in `src/tools/lazyToolGroups.ts` builds the existing one) adds: "If a
   plan is shown, check it against the State section and update it with `update_plan` before
   continuing." The plan shown after a compaction was stale.

Watch only (no change): `omitted-source=true` on every attempt. The summarizer never sees the full
span it replaces. Re-measure it after Phase 1.

### Tests

1. **Prompt snapshot.** The prompt contains the three rules and the injected time.
2. **Resume note.** The note contains the plan-refresh line when a plan exists, and omits it when no
   plan exists.
3. **Offline check, done by hand and not in CI** (the supervisor does it after the commit):
   - Re-summarize the span before compaction 6 of `305fa3a7` with the new prompt on Strata.
   - Targets: at most 15K chars; the 4,000-char limit under Constraints; no "until 02:42".

---

## Phase 5: tool refusals and limits (report §2, §6, §7)

Each item is a result-string change, with one test each that fails before the change.

1. **`exec_command` names a missing explicit path.** When `command` contains a path separator and
   the spawn reports ENOENT, the result says "no executable at `<path>`" (`src/tools/execTools.ts`,
   the `missing_executable` branch around `describeShellBuiltin`). Keep the "Unix utilities are not
   on this PATH" wording for bare names only, and keep the `search_code` hint in both.
2. **`exec_command` recognises `monitor_execution` arguments.** When the arguments include
   `execution_id` or `wait_ms`, the refusal says "these are `monitor_execution` arguments; call
   that tool". Today the schema's `additionalProperties: false` refuses them generically, or the
   call fails on a missing `command`.
3. **`exec_command` recognises a Forge tool name.** When the program's basename, with any extension
   stripped, exactly equals a registered Forge tool name (`find_files`, `search_code`, …), the
   result says "`<name>` is a Forge tool; call it directly". Compare whole tokens against the tool
   registry, never substrings.
4. **`spawn EINVAL` on a `.cmd` or `.bat`** explains that Node cannot launch those without a shell,
   and names the sanctioned route. Nothing handles EINVAL today. Read how `src/agents/cliProcess.ts`
   launches `.cmd` shims, and name the user-facing alternative it implies (for example, `cmd` with
   `/c` as an explicit program).
5. **Flag inline-script writes.** When the program is `node`, `python`, `python3`, `pwsh`,
   `powershell`, `bash` or `sh`, and an argv token is exactly `-e`, `-c`, `--eval` or `-Command`, the
   result gets one line: "Files written by an inline script skip the per-turn checkpoint, so Keep
   and Undo cannot see them. Prefer `edit_file` or `write_file` for edits."
   - Match whole argv tokens, not substrings.
   - No filesystem scan.
   - It never blocks the call.
6. **Clamp numeric limits instead of refusing them.**
   - `monitor_execution`'s `wait_ms` over 60,000 is clamped to 60,000, and the result says
     "wait_ms clamped to 60000".
   - Apply the same rule only to wait and timeout parameters. There are 14 `maximum:` sites under
     `src/tools/`; classify each one in the commit message as clamped or left alone, with the reason.
   - Text limits stay refusals that offer a file alternative.
7. **`web_fetch` gains `find`** (`src/tools/fetchTool.ts`): an optional string. When it is set, the
   result is the `max_chars` window centred on the first case-insensitive match, with a header that
   gives the match offset and total length. With no match, the result says so and returns the first
   `max_chars`. The schema stays strict.

Not in this phase: resolving bare `grep` to Git's `usr\bin`. That is a steering choice that
competes with `search_code`, and the owner decides it separately.

---

## Phase 6: session-log forensics (report §9 lesson 5)

1. **A `tools_offered` row.**
   - Written when the advertised tool list changes:
     - at the first request of a session;
     - after a lazy group load;
     - after a compaction;
     - after any other change to the set of tool names.
   - It holds the sorted tool names and a short hash.
   - It is written only when the hash differs from the last one written in this run.
   - Find where the request's `tools` array is assembled before `ChatClient` dispatch, and log from
     there, through `SessionLogger`.
   - This lets an audit tell "never called" apart from "never offered".
2. **Keep the `internal` flag on user rows.** Messages routed with `internal=true` (job notices,
   live-answer notices, 2b wakes) are logged with `internal: true`. This lets them be told apart
   from real requests.
3. **Readers accept both fields.** `readLogRows` and `ArchivedSessions` read both fields when they
   are present, and treat their absence as legacy.

### Tests

1. **Rows on change only.** A session that loads a group writes two `tools_offered` rows with
   different hashes. A second request with no change writes none.
2. **The internal flag round-trips.** An internal notice row is logged and read back with
   `internal: true`.
3. **Legacy logs.** A log without these fields reads without error.

---

## State × lifecycle ledger

Phases 2a, 3, 4 and 5 write no durable state; they change code, constants and strings. Phase 1 adds a
config field and attempt-row fields. Phase 2b adds a field and an event to the mesh exchange log.
Phase 6 adds log rows.

| Artifact | create | delete | pause/disable | crash mid-write | owner-process death | TTL/expiry |
| --- | --- | --- | --- | --- | --- | --- |
| `token_count` config field (P1; model or group in `config.yaml`) | Written by hand; Zod validates the enum and the provider cross-check; absent means the provider default | Removing it restores the provider default; nothing to clean up | `estimate` is the off switch and is today's behaviour | Config is written by hand or by the atomic `ConfigWriter`; a torn file fails Zod and is surfaced, as today | Not process-owned; re-read on config reload | None; config is permanent |
| Attempt-row measurement fields (P1; session JSONL) | Appended with each `compaction_attempt` row; additive | Deleted with the session log; no new path | Logging disabled → no row, as today | A torn last line is skipped by `readLogRows`; the fields are in the same line | The next window resumes from the `cursor` row; attempts are not resumed | None, same as the log; readers treat absent fields as legacy |
| `originConversation` on the exchange's `created` event (P2b; `exchanges.jsonl`) | Set by `/agent/message` when `forge.sh send` forwards `FORGE_CONVERSATION_ID`; absent for senders outside an `exec_command` | Never deleted alone; it lives and is compacted with the exchange log, as today | Mesh disabled → no exchanges, no wake; Telegram notice unchanged | Appended under the exchange log's interprocess lock in the same line as the event; a torn line is skipped by `readEvents`, so the exchange is treated as having no origin (no wake) | The field is inert; the wake pass in any window that has the conversation open acts on it | Follows the exchange log's existing retention; an exchange that is gone is never woken |
| `wake-<exchangeId>` event (P2b; `exchanges.jsonl`) | Appended by the wake pass under the lock, before routing, by the window where the conversation is open | Same retention as the log | Mesh disabled → the pass does not run | A crash after the append and before routing loses that one wake (at-most-once); the Telegram notice and retained verdict remain | Another window does not re-deliver, because the event exists; a window opened later sees it and skips | Same as the log; a verdict acknowledged before any window had the chat open is never woken, by design |
| `tools_offered` rows (P6; session JSONL) | Appended when the tool-name hash changes | Deleted with the session log | Logging disabled → none | A torn last line is skipped | The next window writes a fresh row at its first request | None, same as the log |
| `internal` flag on user rows (P6; session JSONL) | Set from the routing call's existing `internal` argument | With the log | Logging disabled → none | Same line as the row | Not applicable: the flag is per row, and nothing resumes from it | None, same as the log |

CI-enforceable row: `wake-<exchangeId>`. Phase 2b test 9 seeds an exchange log that already has
the wake event (a crash after the append) and asserts that the pass delivers nothing. Tests 7 and 8
cover the single-window and two-window cases. Together they fail if a later change re-delivers a
wake or delivers one from a window that does not own the chat.

## Acceptance criteria

- **Phase 1:**
  - Tests 1–8 pass, and test 1 fails before the change.
  - Live check on Strata after merge, once the owner sets `token_count: count_tokens` on the entry:
    a session that reaches 85% compacts on the first attempt, and the attempt row shows
    `counter: count_tokens` with a `charsPerToken` between 3 and 4.
  - With `estimate`, `hostMaxChars` is unchanged (test 3).
- **Phase 2a:** tests 1–4 and 4b pass.
- **Phase 2b:**
  - Tests 5–10 pass.
  - Live check after merge: a `forge.sh send` to Codex from an idle Forge chat wakes that chat when
    the verdict lands, with no owner prompt. Repeat once each for Claude and Copilot.
- **Phase 3:**
  - Tests 1–5 pass.
  - The real FORGE.md (25,144 bytes) renders in full, with no marker and with the 90% warning.
  - After a compaction in a session that used `remember`, the key list is present in the host facts.
- **Phase 4:**
  - Tests 1–2 pass.
  - The offline re-summary meets its targets.
- **Phase 5:**
  - One test per item, each failing before the change.
  - The `maximum:` classification is in the commit message.
- **Phase 6:**
  - Tests 1–3 pass.
  - An audit of a new session can list offered-but-unused tools from the log alone.
- **Every phase:**
  - `npm run ci` is green in the worktree.
  - `npx eslint` reports no `max-lines` on touched files.
  - `docs/OWNERS.md` is updated for any new module.
  - The commit message ends with its changelog line.
  - No CHANGES.md edit, no version bump, no push.
