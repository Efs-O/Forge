# Session audit: Telegram Bot API upgrade on Strata Flash-Next (2026-10-05)

Session `305fa3a7-0e98-4ebb-ad6a-0b05f5691be8`, "codex: Implement the Telegram Bot API upgrade un…",
model `strata-flashnext-iq3s`, Forge 0.16.85, 2026-10-04 23:48 → 2026-10-05 07:03 (7 h 15 min).

Sources: the session JSONL (`~/.forge/sessions/305fa3a7-….jsonl`, one `session_start`, monotonic
cursors, so no replay to deduplicate) and the Forge output channel
(`%APPDATA%\Code\logs\20261003T183224\window1\exthost\output_logging_20261004T222410\3-Forge.log`),
which holds the `[compact]` lines the session log does not. Tool results were paired with their calls by
`tool_call_id` (1,242 calls, 1,242 results, 0 unmatched). HalluScribe was not used.

## 1. Outcome

The task finished. Codex supervised every phase through the mesh, as instructed:

| Commit | What |
|---|---|
| `f225283` | Phase 1: resolved approval shown as a disabled button |
| `5750c9f` | Phase 3: tell the sender when a media type is unsupported |
| `a1aa5cf` | Phase 5: `/claude`, `/codex`, `/copilot` one-way tells |
| `ed3edf9` | Phase 2: rich status drafts and native Stop |
| release | 0.16.86: version, CHANGES.md, VSIX packaged and installed |

Phase 4 was research only; it ended with a recorded DEFER decision. Codex sent back two review rounds
with real findings (a Phase 3 blocker and 8 Phase 2 findings), and the agent fixed them.

| Measure | Value |
|---|---|
| Model requests | 1,061 |
| Output tokens | 745,443 |
| Cumulative prompt tokens | 112.2 M (≈106 K per request) |
| Tool calls | 1,242, of which 74 returned `Error:` (6.0%) |
| `npm run ci` runs | 31 (40 background jobs with `notify_on_exit`) |
| Compactions | 6 succeeded, 7 attempts refused, 52 re-triggers suppressed |

## 2. Tool failures

| Tool | Calls | Errors | Rate | Cause |
|---|---:|---:|---:|---|
| `ask_live_session` | 35 | **26** | **74%** | `question` over the 4,000-char cap (§3) |
| `exec_command` | 425 | 28 | 6.6% | mixed, listed below |
| `edit_file` | 209 | 10 | 4.8% | `old_str` not found. Every one was recovered on the next call. |
| `web_fetch` | 14 | 4 | | 404s on guessed `raw.githubusercontent.com/aiogram/...` URLs |
| `exec_file` | 2 | 2 | | hallucinated tool name, called with `{"path":"x"}` |
| `monitor_execution` | 67 | 1 | | `wait_ms: 90000` (max is 60000) |
| `manage_jobs` | 1 | 1 | | interval under the 15-minute minimum |
| `update_plan` | 16 | 1 | | an item text over 200 chars |
| `read_tool_result` | 17 | 1 | | sent both `query` and `message_index` |

Breakdown of `exec_command`:

| Shape | Count | Notes |
|---|---:|---|
| Missing `command` | 6 | e.g. `args: ["diff","--check"]` with no `git`, or `args: [".forge/tmp/tdocs3.mjs", …]` with no `node` |
| `monitor_execution`'s arguments sent to `exec_command` | 3 | `{execution_id, wait_ms, tail_lines}`: the model picked the wrong tool |
| `background: "True"` / `notify_on_exit: "True"` | 4 | Python-style strings. Strata decoding is unconstrained. The refusal is already clear, and every one was fixed on the next call. |
| `args` as a JSON-encoded string | 2 | refusal already clear |
| `rg` timed out after 30 s | 3 | bare `rg` over `.` on N:. `search_code` (136 calls, 0 errors) does the same job. |
| `grep` / `wc` / `find_files` used as a program | 4 | refusals already name the alternative |
| `tsc` / `vitest` timeout | 2 | `timeout_ms` 120–180 s on a full type-check. Should have run in the background. |
| `code.cmd --install-extension` → `spawn EINVAL` | 1 | Node refuses to spawn a `.cmd` file without a shell. The model worked out the cause and switched to `Code.exe` + `cli.js`. |
| `env.PATH` override refused | 1 | by design |

**Verdict:** apart from `ask_live_session`, the error rate is healthy. Every refusal except one was
followed by a correct retry. The exception is `spawn EINVAL`, which names neither the cause nor the fix;
the model worked it out from its own knowledge.

## 3. The character-limit loop (the biggest avoidable waste)

The loop hit both channels the agent used to report to Codex.

**Phase 3, `forge.sh send` (limit 8,000):** the report was 8,846 chars. It took 1 failed send, then
7 `edit_file` trims, each followed by a `wc -c`, before the file came under the limit:
8846 → 8428 → 8244 → 8107 → 8042 → 8034 → 7968. That is about 14 calls.

**Phase 2 and the release, `ask_live_session` (limit 4,000):** four runs, 26 failed calls:

| When | Lengths sent | Failed tries |
|---|---|---:|
| 04:12 | 9696 → 6360 → 5316 → 4678 → 4212 → 3760 ✓ | 5 |
| 05:08 | 4192 → 3930 ✓ | 1 |
| 05:43 | 5547 → 5144 → 4862 → 4401 → 4379 → **4384** → 4067 → 4051 → 4043 → 4031 → 4022 → 4018 → 3985 ✓ | 12 |
| 06:31 | 6001 → 5267 → 4728 → 4669 → 4101 → 4089 → 4085 → 4001 → 3993 ✓ | 8 |

Cost: about 14 minutes of wall time and about 35 K output tokens. Each retry regenerates the whole
~4 K-char message, which takes ~30 s and ~1,200 tokens.

Why it happens:

1. **The model cannot count characters.** It trims by feel, usually by 10–50 chars at a time, and once
   it made the message longer (4379 → 4384). Telling it "you are 384 over" does not help. It needs an
   instruction it can follow without counting.
2. **It knew about the limit and still overshot.** After the 05:41 compaction its reasoning says "Note
   the mesh limit is ~4000 chars for the question. So I should send a condensed…", and then it sent
   5,547 chars.
3. **The full report was already on disk** (`.forge/tmp/release-report.md`, 10,638 chars), and every
   message said "FULL report on disk — read it". Codex can read files. The inline condensed copy was
   duplication, and the cap only ever cut that copy.
4. **Codex's kickoff prompt asked for a long inline report:** "Report files changed, key design choices,
   exact test results, git diff --check and status, risks/questions, and the proposed commit message".
   That list does not fit in 4,000 chars of prose for a phase of this size.
5. **The schema hides the number.** The `question` description never states the limit in words. It
   appears only as `maxLength`, which Strata does not enforce, and the description says nothing about
   sending a file instead.

**Where the 4,000 comes from.** It is not Telegram's limit: `ask_live_session` never goes through
Telegram, and Telegram's 4,096 is enforced separately in `src/remote/TelegramText.ts`. The agent bus
plan (`docs/plans/AGENT_BUS_TOOL_PLAN.md`) gives one reason: "Bounded, like `ask_local_agent`'s
`task`". The number was copied from another tool; no constraint was measured. The one real ceiling is
further down:

- `queueToCodex` passes the whole message on the command line
  (`codex queue --thread … --message <text>`).
- On the default `codex_cli: codex`, that resolves to npm's `codex.cmd`. `spawnCliProcess` wraps it in
  `cmd.exe`, whose command line is limited to **8,191 chars**.
- `codexMessage` adds about 550 chars around the question: the header, a subject of up to 160 chars,
  the reply-path contract, and the path. cmd quoting also adds an unknown amount.
- This machine's config points `codex_cli` at `codex.exe`, which has the 32,767-char `CreateProcess`
  limit. Questions to Claude go through files and the mesh, so they have no argv limit.

So **8,000 is unsafe** for the default Codex route, but **6,000 fits**. In this session, a 6,000 cap
would have cut the 26 failures to 3 (9,696 and 6,360 fail, then 5,316 passes; 6,001 fails, then 5,267
passes; 5,547 and 4,192 pass first time).

Fixes, cheapest first:

- **Raise `MAX_QUESTION_CHARS` to 6,000,** with a unit test that builds a worst-case `codexMessage`
  (a 160-char subject, a 6,000-char question full of quotes and `^`/`%`/`&`, and a long reply path),
  passes it through `buildWindowsCmdShellInvocation`, and asserts the command line is under 8,191. The
  test pins the limit to the real constraint, so a later change to the wrapper fails CI instead of
  failing in use. Do not unify with `forge.sh send`'s 8,000 for this reason. Instead, name each limit in
  its own description.
- **Rewrite the refusal** in `src/tools/liveSessionTool.ts` (`stringArg`) so it names the sanctioned
  alternative, as the CLAUDE.md rule "Refusals must name the sanctioned alternative" requires. Suggested
  text: *"question is 4,384 chars; the limit is 4,000. Do not trim and resend. Write the full report to
  a workspace file, then send a question of at most 1,500 chars: the decision you need, a 3–5 line
  status, and the file path. The other session reads the file itself."* The number 1,500 matters. A
  target far under the cap succeeds on the first try even though the model's counting is poor.
- **State the limit in the `question` description** and point long reports at a file:
  "At most 4,000 characters. For a report, write it to a file and name the path here."
- **Optional:** add a strict `report_path` field (a workspace-relative file) that the tool attaches or
  points to. This removes the problem without any prose. Check it against `forge.sh send`, which
  already relays a file, so the two channels do not diverge further.
- **Improve the Codex kickoff prompt:** "Write each phase report to `.forge/tmp/phase-N-report.md`.
  Send at most 1,500 chars: the verdict you need, the CI result line, and the path."

## 4. Compaction: why 7 attempts failed, and why the next one succeeded

### What failed

All 7 failures were `budget-refusal`, logged in the same millisecond as their `start` row, so no model
call was made. Each time, the Forge log shows `shed optional host facts to fit: repo state, memory
keys, last reply`, and then nothing more. The refusal came from `refuseHostFacts`
(`src/sidebar/compactionHostFit.ts`). After every optional fact had been shed, the **required** host
facts were still over budget. Those facts are the verbatim user requests (capped at 12,000 chars by
`USER_CONTEXT_MAX_CHARS`) plus the recorded actions.

### Why it succeeded later: "larger context" means more *used* tokens

The window was 200,000 tokens throughout. The difference is that the host budget is a **percentage of
the tokens currently used** (`src/sidebar/compactionBudget.ts`):

```
hostMaxChars = max(6000, usedTokens × 0.035 × 2.5) = usedTokens × 0.0875
```

So every 4 K tokens the conversation grows raises the host allowance by about 350 chars. The required
host facts stayed roughly the same size (about 15.3–16.5 K chars), so each refusal was followed by more
work, a fuller context, and a retry, until the allowance passed the facts:

| Run | Used tokens | Host budget (chars) | Host facts (log, ×2.5) | Result |
|---|---:|---:|---:|---|
| gen 3 | 169,177 | 14,803 | ~15.4 K | refused |
| | 175,255 | 15,334 | ~15.4 K | refused |
| | **179,300** | **15,689** | 15,378 | **compacted** |
| gen 4 | 173,717 | 15,200 | ~16.4 K | refused |
| | 178,588 | 15,626 | | refused |
| | 182,942 | 16,007 | | refused |
| | **191,040** | **16,716** | 16,475 | **compacted, at 95.5% of the window** |
| gen 5 | 170,823 | 14,947 | ~15.7 K | refused |
| | 175,255 | 15,334 | | refused |
| | **179,419** | **15,699** | 15,685 | **compacted, with 14 chars to spare** |

Between attempts, `autoCompactionPolicy` suppressed 52 re-triggers ("next transient retry after
15000 ms or 4000 context tokens"). The suppression did its job: no wasted summarizer calls. But the
retry could only succeed because the context had grown. Gen 4 compacted at 191 K of 200 K, about 9 K
tokens from overflow.

### The design flaw

A **fixed-size** required block (user requests up to 12,000 chars, plus recorded actions that only
grow) is checked against a **proportional** budget (3.5% of usage). At the 85% trigger (~170 K) the
budget is 14,875 chars, and the user-request cap alone is 81% of that. Once a long session fills the
user block with long Codex instructions, every compaction at the trigger point is refused by
construction. It then waits for the context to grow.

**The refusals were a unit-conversion artifact.** The budget is defined in tokens (3.5% of P) and
converted to chars at `COMPACTION_CHARS_PER_TOKEN = 2.5`. On Strata's own tokenizer
(`/v1/messages/count_tokens`, 16–39 ms per call), this session's text measured as follows:

| Text | Chars | Strata tokens | Chars/token |
|---|---:|---:|---:|
| Preserved user-request block (first request + newest-first, 12,000 cap) | 12,009 | 3,740 | 3.21 |
| The six compaction summaries | 9,206–21,399 | 2,333–5,990 | 3.56–3.95 |

At about 3.2 chars per token, the 15.4–16.5 K chars of host facts come to about 4,800–5,200 tokens.
The token budget at the first refused attempt (169,177 used) was 5,921. **All 7 refused attempts
would have been admitted at the trigger** if the facts had been measured instead of estimated. This
matches what the
research report (`COMPACTION_RESEARCH_COMPARISON_2026-10-04.md`, design step 4) and the handoff
comparison (`COMPACTION_HANDOFF_COMPARISON_2026-10-03.md`) already called for: "budget with the actual
model tokenizer where available; character caps remain a safety bound".

Fixes, best first:

1. **Measure the host facts with the backend's tokenizer** (Codex's proposal). Strata exposes
   `/v1/messages/count_tokens`. llama-server exposes `/tokenize`, and `ServerTokenCounter`
   (`src/search/TokenCounter.ts`) already wraps it. Where a backend has no counter (Ollama, some
   cloud providers), keep the 2.5 estimate as the explicit conservative bound, and say in the log which
   one was used. This removes the cause of every refusal in this session.
2. **Still size the user-request block from the budget instead of a constant.** The tokenizer does
   not fix the structural mismatch at small P. A manual `/compact` at 60 K used tokens has a host
   budget of about 2,100 tokens, but this session's user block alone is 3,740 tokens, so it would
   still be refused. Pass
   `hostMaxChars − recordedActionsText.length` into `collectCompactionUserMessages` as its char limit.
   Its newest-first fill already handles a smaller limit cleanly: the first request is always kept, and
   older middle entries drop out first. Refusal then only happens when the first request plus the
   recorded actions overflow by themselves.
3. Alternatively to 2, compute `policyTokens` from the trigger threshold (`threshold × max`) rather than the
   observed usage, so the budget does not depend on how late the attempt runs.
4. **Put the refusal detail in the durable attempt row**: `hostChars`, `hostMaxChars`, the counter used (tokenizer or estimate), and the largest
   component, which `refuseHostFacts` already computes. The session log says only `budget-refusal`.
   This diagnosis needed the exthost log, which VS Code rotates away.
5. Add a CI test with a realistic shape: 24 user messages of ~500 chars each plus 40 recorded actions,
   at `used = 0.85 × 200 K`, asserting that the compaction is admitted.

## 5. The new compaction method: assessment

The one-request, low-reasoning compaction with 6% / 12% budgets (`19eb4c3`) works well when it is
admitted:

- **6 out of 6 admitted runs succeeded on the first call.** Each took 2–3.5 min (`calls: 1`,
  `finish_reason: stop`). No retries, no truncated summaries, no invalid-summary rejections.
- **6 out of 6 resumes were clean.** After every compaction, the agent's first reasoning restated the
  correct phase and next step. Examples: "Phase 5 implementation complete… Next: re-run npm run ci"
  and "Phase 2 fixes for Codex's 8 findings". It never redid committed work, and it never lost the
  STOP-BEFORE-COMMIT / await-GO protocol across six generations. The original task statement, the phase
  order, and the "untracked DESKTOP plan must stay out" constraint all survived to the end.
- The replacement stayed small: 7.8 K → 16.5 K estimated tokens, against 170–191 K before.

Weak points:

- **The admission check** described in §4, the real problem.
- **The summary grows every generation**: 9.2 K → 12.6 K → 12.7 K → 19.5 K → 19.0 K → 21.4 K chars.
  The previous summary is folded into the next one, so history builds up. It is still well under the
  ceiling, but over a longer session it will compete with the host facts for the same 12% budget.
- **`omitted-source=true` on every run.** The summarizer never saw the whole span it replaced. Resumes
  were still correct, because the recorded actions and the user requests carry the facts that matter.
  Keep an eye on this.
- After the gen-5 compaction, the plan injected into the turn context was stale ("Phase 2 pending",
  while it was committed). The agent noticed and trusted the summary instead. Refreshing `update_plan`
  is not part of the resume.

Overall: the method is a clear improvement. A single bounded call with a structured summary and verbatim
user intent is the right design for a local model. Fixing admission (§4, fix 1) is the one change that
matters.

## 6. Useful tools the agent did not use

The session log does not record which tools were advertised (see §7), so "not called" here means "a
fitting tool exists and the agent reached for `exec_command` instead". A breakdown of the 425
`exec_command` calls shows the substitutions:

| Instead of | It used | Calls | Matters? |
|---|---|---:|---|
| `ask_live_session` with `notify_on_answer` | blocking `ask_live_session`, or `forge.sh send` plus manual `read-verdict` | 0 of 35 non-blocking | **Yes.** At 01:57 the owner said Codex might be out of credits until 02:42. The agent wrote a `remember` entry saying "use notify_on_answer / non-blocking send", and then never used it. |
| `search_code` / `read_file` line ranges | `node -e` scripts that split files and regex-print lines; `bash -c grep/sed/head` | 37 `node -e`, 105 `bash` | Moderate. It works, but the agent writes throwaway code, and bare `rg` timed out 3 times. |
| `git_read` (status / diff / log / show) | `exec_command git …` | 67 git calls against 4 `git_read` | Low. Same results, but `git_read` output is bounded and resolves the cwd from the path. |
| `edit_file` / `write_file` | `node -e "fs.writeFileSync(p, L.slice(0,323)…)"` truncating `test/unit/RemoteGenerationStopped.test.ts` | 1 | **Yes.** A write through `exec_command` bypasses the per-turn checkpoint, so Keep/Undo cannot see it. |
| `format_file` | `npx eslint --fix` | 3 | Low. |
| `code_intel` (document symbols, references) | grep for symbols | 1 call | Low to moderate. Finding references would have helped the cross-phase review. |
| `web_fetch` | Six hand-written `.forge/tmp/tdocs*.mjs` scripts that fetch `core.telegram.org/bots/api` and slice out sections | 19 runs | **Tool gap.** The Bot API page is too large for `web_fetch`'s `max_chars`, and the tool cannot jump to an anchor or search. Adding a `find` / `anchor` parameter would have replaced every script. |
| `delete_file` | nothing | 0 | `.forge/tmp/` was left holding about a dozen reports and scripts. |

Not used and not needed: `tell_live_session`, `run_workspace_task`, `rename_symbol`, `move_file`,
`schedule_wake`, `stop_execution`, and the browser/desktop tools. (`wait` was needed once; see §8.)

## 7. Other limits, and calls by trained tool names

**Other limits.** Apart from `ask_live_session` (§3) and the compaction user block (§4, which the
tokenizer fixes), no limit caused more than one failure:

| Limit | Failures | Action |
|---|---:|---|
| `monitor_execution` `wait_ms`, 60,000 max | 1 (90,000 sent) | **Clamp to the maximum and say so in the result.** The intent was unambiguous, so a refusal only costs a round. Apply the same rule to every numeric limit. |
| `update_plan` item, 200 chars | 1 | Keep it. |
| `manage_jobs` interval, 15 min minimum | 1 | Keep it; the minimum is deliberate. |
| `web_fetch` page size | 6 scraper scripts | Add `find`/anchor instead of raising the cap (§6). |

The rule: **clamp numbers, and refuse text with a file alternative.** Cutting text silently loses
content, while clamping a number loses nothing that was meant.

**Trained tool names.** Only **2** calls used a tool name that does not exist: `exec_file {"path":"x"}`,
twice. Those look like probing rather than a trained name. There were no calls to `bash`,
`str_replace_editor`, `view`, `grep` or `glob` as tools. The model used Forge's names correctly
(`read_file` 241, `edit_file` 209, `search_code` 136). Renaming tools to match training data is not
warranted.

Training shows up one level down instead, as Unix habits inside `bash -c`. Counting the first word of
each command in a pipeline: `head` 60, `echo` 53, `grep` 32, `git` 17, `sed` 6, `wc` 3, plus
`cat`/`ls`/`awk`. These all worked through Git Bash. The cost is efficiency, not failures. There were
also two mix-ups between tools:

- `find_files` was called as a program in `exec_command`, and got a bare `spawn find_files ENOENT`.
- `monitor_execution`'s arguments (`execution_id`, `wait_ms`) were sent to `exec_command` 3 times.

Both deserve a refusal that names the right tool: "`find_files` is a Forge tool, call it directly", and
"these are `monitor_execution` arguments".

**The grep "full path" failure was a misleading message, not a block.** Explicit paths are not
blocked: `exec_command` spawned `C:\Program Files\Git\usr\bin\grep.exe` with `shell:false` without
trouble when tested. The model guessed `C:\Program Files\Git\bin\grep.exe`, but Git's `bin\` holds only
`bash`, `git` and `sh`, so the spawn got ENOENT. `execTools.ts` then rewrites any missing-executable
error whose basename is a known utility (`describeShellBuiltin`) into "Unix utilities are not on this
PATH". For an explicit path that is false, and it pushed the model to `bash -c grep` 32 times.

Fix: when `command` contains a path separator and the spawn reports ENOENT, say *"no executable at
`<path>`"* and keep the `search_code` hint. Keep the PATH wording for bare names. An optional extra:
resolve bare `grep` to the `usr\bin` of the Git install that `resolveGitBash` already finds, the same way
bare `bash` is handled. That is a choice about steering (it competes with `search_code`), so it is not a
bug fix.

## 8. Under-advertised tools, the 02:35 idle, memory, summaries and FORGE.md

### The 02:35 idle: a verdict does not wake the agent

Timeline:

- **02:23:41** The agent sent its report through `forge.sh send`.
- It tried a `manage_jobs` poll job to check for the answer. That was refused, because the interval
  must be at least 15 minutes.
- It did Phase 4 research.
- **02:34:43** It ended the turn. Its reasoning said "Codex's verdict will arrive as a new agent-bus
  turn".
- **02:35:13** The owner had to prompt it.
- **02:36:03** Codex's answer arrived.

The agent's belief was wrong. Here is what happens to a verdict file for an exchange the chat sent:

`meshVerdictPoll` → `onEvent` (`agentMeshSetup.ts`) → `meshEventNotification` →
`PendingHostActivity` → `emitHostActivity`

The last step reaches only the remote-transport listeners. The owner sees a Telegram notice, and the
model sees nothing. Only `ask_live_session` with `notify_on_answer: true` starts a model turn when
the answer lands.

The agent had even recalled its own memory at 02:25, "use notify_on_answer / non-blocking send", and
still used `forge.sh send`. That is lesson 4 again.

What it should have done is clear. The tools existed, but nothing pointed to them at the moment of
need:

| Tool | Why it went unused |
|---|---|
| `ask_live_session` with `notify_on_answer` | Used 0 times out of 35 sends. The `forge.sh send` result does not say "this will not wake you". |
| `wait` | Eager, and it "ends early when a new message arrives". Nothing pointed to it: the `manage_jobs` refusal named only the 15-minute minimum. |
| `read-verdict` | Used correctly when the agent remembered to poll. Nothing reminds it to poll. |

Fixes, cheapest first:

1. **The `forge.sh send` result and the header doc** should say: "Sent. The verdict will NOT start a
   turn. Use `ask_live_session` with `notify_on_answer`, or `wait` and then `read-verdict`."
2. **The `manage_jobs` interval refusal** should add: "To wait for a reply, use `wait` (ends early
   on a new message) or `notify_on_answer`."
3. **Structural fix:** a verdict for an exchange that *this conversation* sent should be injected as
   an internal message and start a turn when the chat is idle. That is the same path that
   `notify_on_answer` already uses. It is the only fix that does not depend on the model reading a
   hint. It needs the exchange to be recorded with its conversation id when it is sent, so this one
   belongs in the plan doc.

### Memory: why it is used in some sessions and never in others

Of 12 sessions since 2026-09-30, 4 used the memory tools:

| Session | Calls |
|---|---|
| 305fa3a7 (this one) | load ×2, remember ×3, recall ×1 |
| e4fad55b | recall ×5, remember ×2, list ×1 |
| 8c170fd7 | remember ×11 |
| fc95b977 | recall ×1, with no load |

Four causes stack up:

1. **The `memory` group is lazy** (`lazyToolGroups.ts`). The model sees only one line about it in
   `load_tool_group` ("save and recall durable project and user memories"). Whether it loads the
   group is down to chance. The group holds just 4 small tools.
2. **Loaded groups are dropped at every compaction** (`deactivateLazyGroups`). The summary ends with
   "Loaded optional tool groups before compaction: memory. Reload with load_tool_group if needed."
   This session reloaded once and then stopped.
3. **The `remember` description promises something compaction does not deliver.** It says "Keys are
   listed back to you after every compaction". In fact memory keys are an *optional* host fact, shed
   second after repo state. They were shed in **4 of the 6** successful compactions here. The one key
   that mattered (`codex-availability-2026-10-05`) survived only because the model copied it into
   its summary's Constraints.
4. **The FORGE.md memory rule is cut mid-word** (see below). The model never sees the end of the
   rule that tells it when to use memory.

Fixes:

- Make `memory` eager. It costs about 4 schemas, and a lazy tool group defeats the point of memory.
- Make memory keys a required host fact, or shed them last. A key list is a few hundred characters,
  and it is the only cheap thing that survives compaction by design.
- If the group stays lazy, keep loaded groups across compaction. That is a cold prefill either way.

### Compaction summaries: adequate, with one growing problem

I read summaries 2 (02:17), 5 (05:41) and 6 (06:57) against the session state at each point. **They
are good.** Each one carries:

- the full phase protocol (STOP BEFORE COMMIT → report → await GO);
- every commit hash with its parent;
- Codex's verdicts, quoted;
- the owner's steering, including the untracked desktop plan and the "new chat" instruction;
- the open flaky tests with their isolation results;
- an exact Next step.

No task drift followed any compaction. The agent resumed exactly where each summary said.

The problems:

| Problem | Evidence |
|---|---|
| **The Errors section is an append-only log** | Errors section: 1.9K → 2.9K → 2.7K → 6.2K → 7.1K → **7.9K chars**, 37% of summary 6. Most entries are long-fixed typos (`background:"True"`, a missing `command` field), repeated phase after phase. |
| **Stale constraints are carried forever** | "Codex unavailable until 02:42" was still in the summary at 06:57. |
| **Limits sat under Errors, not Constraints** | Summary 5 recorded "Mesh report exceeded 4000-char limit (9696, 6360, 5316, 4678, 4212)" as a fixed error. Summaries 2–5 never listed the limit as a constraint, and the agent overshot again after summary 5. Summary 6 finally promoted it ("`ask_live_session` question limit: 4000 characters"). |

Total summary size grew from 9.2K to 21.4K chars. Errors alone explain 6K of that growth, and
Files explain another 1K.

Fix, in the compaction prompt:

- **Errors** should hold unresolved items, plus *lessons* stated once (for example "booleans are
  lowercase `true`"), not a history.
- A limit that was hit belongs in **Constraints**.
- A time-bound constraint is dropped once its time has passed.

That keeps the summary near 12–14K, which also eases the admission math in §4.

### FORGE.md is over its budget and silently cut

`MAX_INSTRUCTION_BYTES = 25000` (`forgeInstructionsChain.ts`). The repo-root FORGE.md is
**25,144 bytes** (6,515 Strata tokens), 144 bytes over the budget. When it is the only file, it goes
down the lone-file path. That path clamps without the `TRUNCATION_MARKER`, so the model gets no sign
that anything is missing. The cut lands at:

> - **Review task memories when finishing work that used them.** Update durable facts with `reme

The rest of the memory rule is lost: "…use `forget` for pending-only notes… Do not clear all
memories automatically." (`reportBudget` does notify the user. That happens once, and is easy to
miss.)

**Raising the budget by about 2K tokens is right.** At about 3.5 chars per token, that is 7 KB, so the
budget becomes **32 KB**. The cost:

- about 1.7K extra tokens in every prompt, under 1% of the window;
- prefix-cached, so it is paid once per slot.

One clarification: FORGE.md is not part of compaction. It sits in every prompt and survives
compaction untouched. A small compaction budget therefore makes FORGE.md *more* valuable as the
always-present carrier of rules, which is the right argument for raising it.

Do it with three changes:

1. Raise `MAX_INSTRUCTION_BYTES` to 32,000.
2. Add the truncation marker on the lone-file path, as the multi-file path already does.
3. Warn at 90% of the budget (in `reportBudget`, or as a CI size check on the tracked template) so
   the next overflow is caught before it cuts a rule.

Measuring the budget in tokens would fit the tokenizer work in §4. It is optional, since bytes are
stable enough for a fixed file.

## 9. Lessons for agent execution

1. **A character cap the model must meet by itself has to come with a strategy, not a number.** Local
   models do not count characters. Every capped free-text field should either accept a file reference
   or answer a failure with a target far below the cap (see §3). This is the single largest saving
   available from this session.
2. **Fixed-size required content needs a fixed-size budget.** Wherever a proportional budget guards a
   block with a constant cap, check the ratio at the trigger point (§4).
3. **Supervisor prompts should specify the report format**, and should prefer a file plus a short
   message. The Codex prompt did that for the commit protocol, which worked flawlessly, but not for the
   report size.
4. **The agent records the right strategy and does not follow it.** Two examples: the `notify_on_answer`
   memory, and the 4,000-char limit acknowledged in its reasoning before it overshot. A remembered rule
   loses to the shape of the tool in front of it. Fix the tool contract, not the prose (see the
   CLAUDE.md lesson "the lever is the tool contract").
5. **Forensic gaps found:**
   - The session log has no record of the advertised tool list, so "never called" cannot be told
     apart from "never offered".
   - It does not keep the `internal` flag on user rows. Job notices and real requests look the same.
   - `compaction_attempt` rows lack the refusal detail.
   Each of these cost time in this audit.
6. **Small tool fixes:**
   - `spawn EINVAL` on a `.cmd` file should explain the Node restriction and point to the sanctioned
     route.
   - `exec_command` called with `execution_id` should answer "did you mean `monitor_execution`?".
   - `exec_command` writes are an uncheckpointed write path. At least flag them in the result.
7. **The overall result was good.** Five commits plus a release, done overnight by a local model with
   real review rounds. The tool error rate outside the cap loop was about 4%, every non-cap failure
   but one was followed by a correct retry, and six compactions passed with no task drift. Strata
   Flash-Next can run multi-hour supervised work. The losses came from the tools and the budget math.
