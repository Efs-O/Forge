# Compaction handoff investigation — 2026-10-03

## Scope and evidence

Read-only inspection of the active Forge conversation in VS Code workspace state, its extension log, Forge's compaction and memory code, recent local Codex and Claude session records, and official Codex memory documentation. This remains the evidence record for the owner-selected implementation plan in `docs/plans/COMPACTION_MEMORY_SEARCH_RECOVERY_PLAN.md`.

The Forge session was the October 3 commit audit. Its persisted conversation ID was `e4fad55b-ba0f-4a15-b394-542859990305`. The live transcript was still growing during inspection; message counts below describe the inspected snapshot, not a final session length.

## Forge event

- The extension log at `2026-10-03T18:53:28.675Z` recorded `[auto-compact] mid-turn at 90% — compacting`. The summarization request immediately afterward had `message_chars=34940`, `max_tokens=32768`, and no tools. That request includes host-provided material as well as the bounded transcript excerpt; `message_chars` is not the excerpt limit.
- The persisted compaction had generation 1, a cut point at message index 309, and a **3,018-character model-written summary**. Forge also preserved the original user request, six memory key names, 33 host-recorded actions, and a working-tree snapshot outside that summary. These components must not be counted as part of the 3,018 characters.
- Just before the cut, the agent was still checking candidate audit findings and running scratch probes. The summary named the goal, several commands and files, and a broad next action. It did **not** carry a complete commit list or a finding-by-finding record with evidence and verification status. Its `Next` section said to produce the final report even though the audit was still in verification.
- Immediately after compaction, the agent loaded the memory tool and recalled `bug-hunt-findings`, `bug-hunt-next`, and `bug-hunt-task`. Those memories belonged to an older, separate bug hunt. The agent then made many `read_tool_result` calls and reread repository files to reconstruct its audit state. This supports the conclusion that the active audit handoff was insufficient; the unrelated memories were a secondary recovery mistake.

## Forge limits are fixed across context sizes

The following limits in `src/sidebar/compactionPrompt.ts` and `src/sidebar/compactionSplit.ts` do not scale with the configured model context:

| Component | Limit |
| --- | ---: |
| Transcript excerpt supplied to summarizer | 24,000 characters |
| Individual non-tool message in that excerpt | 3,000 characters |
| Individual tool result in that excerpt | 2,000 characters |
| Requested summary | Under 600 words |
| Stored model-written summary | 8,000 characters maximum |
| Summary output target | 3,072 tokens, with `PromptRun` allowing a larger configured sampling maximum |
| Recent protocol tail retained verbatim | Up to 4,000 costed characters |

The 24,000-character excerpt keeps whole messages from the beginning and end, with 30% of its budget allocated to the beginning. Host-preserved user requests, recorded actions, repository state, and any plan snapshot are added separately to the summarization prompt. The 8,000-character cap applies to the model-written summary, not the entire replacement context.

Consequently, a 200k-context session can accumulate much more work than a 100k-context session before compaction, while the transcript excerpt, summary instruction, stored summary cap, and retained tail stay the same. This is a plausible explanation for greater information loss at larger context sizes, **not proof** that the context increase alone caused this particular failure. No earlier successful 151k session was compared in this investigation.

## Proposed percentage-based compaction budgets (not implemented)

Use `P` for the **measured tokens in the context being compacted**, rather than the model's maximum context size. With the current Strata configuration, automatic compaction at 85% of 200,000 tokens means `P` is roughly **170,000 tokens**. Ten percent of `P` is **17,000**, not 20,000 tokens. The largest observed Claude post-compaction context in this investigation was 12,293 tokens, so 17,000 is a generous ceiling, not a target.

| Component | Proposed rule | Example at `P = 170,000` |
| --- | ---: | ---: |
| Transcript supplied to summarizer | Up to **80% of P**, subject to a full-request token-fit check | Up to **136,000 tokens** |
| Model-written summary target | **3.5–4% of P** | About **5,950–6,800 tokens** |
| Model-written summary ceiling | **5% of P** | **8,500 tokens** |
| Recent verbatim protocol tail ceiling | **1.5% of P** | **2,550 tokens** |
| Preserved user requests, action facts, repo state, memory keys and other host facts | Budget up to **3.5% of P** | Up to **5,950 tokens** |
| Entire model-facing replacement context target | About **7% of P** | About **11,900 tokens** |
| Entire replacement context ceiling | **10% of P**, including summary, facts and tail | **17,000 tokens** |

These are **proposed starting values**, not Strata-validated settings. The existing “under 600 words” summary instruction would have to be removed. The source budget must also fit within `num_ctx` after accounting for the complete summarization prompt and room for generation and reasoning; `80% of P` is an upper bound, not an unconditional allocation. A model's `max_tokens` setting is not itself a cap on the visible summary because a thinking model may spend part of that budget reasoning.

The main budgets should use measured token counts rather than a fixed characters-per-token conversion. Keep per-message and per-tool-result safety limits so one oversized result does not consume the source budget, but select essential task evidence before trimming. If required user instructions or host-recorded facts cannot fit inside the replacement ceiling, Forge should surface that condition rather than silently discard them. A replay of the failed commit audit should verify that the full commit list and each finding's evidence and status survive; summary length alone is not an acceptance test.

## Forge's separate memory store

Forge's `remember`, `recall`, and `list_memories` tools in `src/tools/memoryTools.ts` use VS Code workspace state. They store named string values under `forge.memory.<key>` and keep a key index under `forge.memory.__keys__`. This is **not a separate memory file**: the values are inside the Forge extension's entry in this workspace's `state.vscdb`. They are workspace-wide rather than specific to one conversation. The `remember` schema has no explicit value-length cap, and overwriting a key replaces its value.

At inspection, the store had six keys and **5,683 characters of values** (about 5.7 KB of UTF-8 text). The database file itself was about 94.7 MB because it also holds conversation and other VS Code state. The six entries were:

| Key | Stored content |
| --- | --- |
| `demo-memory` | A test value: “hello from the remember tool.” |
| `tool-schema-audit-plan` | A pending plan to measure and shorten Forge's tool definitions. |
| `codex-stand-in-handoff` | A September 29 handoff for validating Codex stand-in integration, including one open interruption finding. |
| `bug-hunt-task` | Instructions for a separate October 2 Claude-requested serious-bug audit. |
| `bug-hunt-findings` | One claimed SSRF finding in `fetchTool.ts` and a list of areas that audit considered clean. The claim was not reverified here. |
| `bug-hunt-next` | Remaining files and reporting steps for that October 2 bug hunt. |

Forge lists memory **keys**, not values, in the post-compaction replacement context; the agent has to call `recall` for a value. There was no dedicated memory for the October 3 commit audit. Three of the six keys referred to the older bug hunt, which explains why recalling them did not recover the active audit's findings. This is distinct from the incomplete compaction summary: stale or unrelated memories did not create its omissions.

## Local Claude comparison

The recent Forge-project Claude session `bd446f93-55e2-4535-b9d6-8ce4bf022891.jsonl` recorded two automatic compactions. The readable handoff messages immediately after their `compact_boundary` records contained **10,862** and **15,007 characters**. The boundary metadata reported `preTokens` of **169,019** and **167,586**, respectively, and `postTokens` of **6,024** and **10,333**. `postTokens` includes more than the summary text.

Another Forge-project Claude session, `7b39fb6e-82a8-457e-b72e-c5ded39fe567.jsonl`, had 18 boundaries. Their readable handoffs ranged from **11,157 to 20,574 characters**. Seventeen boundaries reported `preTokens` between roughly **165k and 170k**; one was near **100k**. These are observed session measurements, not a documented fixed Claude summary limit.

## Local Codex comparison

The September 28 Codex session `rollout-2026-09-28T01-22-10-01a0e4f6-1e6d-73d0-8a21-a29111492e6a.jsonl` recorded two compaction items. Their `encrypted_content` fields contained **14,456** and **15,672 characters**. The corresponding token-usage records reported **223,091** and **231,381 input tokens**. Each replacement history also contained other retained items (60 and 66 items, respectively).

These are **encrypted payload lengths, not readable summary lengths**. They cannot be compared character-for-character with Forge's or Claude's prose summaries, nor do they reveal exactly which facts Codex retained. Official OpenAI documentation describes the Responses API compaction item as opaque and says the returned compacted window may include retained items; it does not establish that every Codex product surface uses an identical internal path: <https://developers.openai.com/api/docs/guides/compaction>.

## Codex's separate local memories

Codex also has cross-chat memories, separate from same-chat compaction. When enabled, it can generate local memory files from eligible prior chats after they have been idle, then make those memories available to later chats. The main files live under `~/.codex/memories/`; ChatGPT desktop and Codex CLI offer per-chat controls over using existing memories and contributing to future ones. This differs from Forge's explicit `remember(key, value)` and `recall(key)` store. Official documentation: <https://learn.chatgpt.com/docs/customization/memories>.

The Codex memory feature is off by default (<https://learn.chatgpt.com/docs/config-file/config-basic>). On this machine, inspection found neither a memory setting in `~/.codex/config.toml` nor a `~/.codex/memories/` directory. That is evidence of no locally generated Codex memories in the default location, although it does not establish every possible desktop setting. Codex goals and `AGENTS.md` instructions are other forms of durable state; neither is the same as cross-chat memories or same-chat compaction.

## Memory lifecycle finding and proposed guidance

Forge has no task-completion policy for memories. Task-specific notes can remain in the workspace-wide store after their task ends, and the next agent can mistake them for the active task. Adding guidance to `FORGE.md` would help: **when a task used `remember`, review its task-specific memories at completion; update facts worth keeping and remove notes that only describe pending work; leave other tasks' memories alone.** This is a proposal, not a change made in this investigation.

The tool catalog currently has `remember`, `recall`, and `list_memories`, but no operation to delete a single memory. Overwriting a value with an empty string would leave its key in the index and in post-compaction key lists. A small, key-scoped `forget` tool would be needed for actual cleanup: remove the stored value and the matching entry from `forge.memory.__keys__`. No such tool has been added.

Memory cleanup and compaction quality are separate concerns. It would have prevented the old bug-hunt keys from misleading the agent, but it would not have restored the October 3 audit findings omitted from the summary.

## Tool failures in the audited Forge session

The agent called `exec_command` with `rg --version` once. It failed because bare `rg` was unavailable to the shell-free command runner. This was a mismatch between the audit's explicit “use rg” instruction and Forge's interface: `search_code` already resolves VS Code's bundled ripgrep, but `exec_command` does not resolve a bare `rg` to that binary. `src/tools/RipgrepResolver.ts` owns binary discovery; `src/tools/execProgramResolver.ts` currently suggests `search_code` when a bare `rg` spawn fails. Successful `search_code` calls in the transcript show that the search capability itself remained available.

Ten other calls failed: one mistaken `npx test run` command, two failed scratch Vitest probes, four malformed `exec_command` calls, and three `read_tool_result` calls using a tool-result message index instead of a tool-call ID. The probes are experiments, not necessarily tool-use defects. A `git grep` exit code 1 and two `find_files` no-match responses were searches with no matches, not broken tools.

The selected search-interface change is to make bare `rg`/`rg.exe` in `exec_command` resolve to the same bundled ripgrep binary, while retaining `search_code` and its existing scope, exclusion, and output behavior. This has not been implemented; the corresponding implementation plan is `docs/plans/COMPACTION_MEMORY_SEARCH_RECOVERY_PLAN.md`. This report remains the evidence record.

## Live configuration change made after the investigation

At the owner's request, the live, gitignored `.forge/config.yaml` was changed in exactly two places:

| Setting | Before | After |
| --- | ---: | ---: |
| `strata-flashnext-iq3s.num_ctx` | 192,000 | **200,000** |
| `auto_compact.at` | 0.90 | **0.85** |

The changed YAML parsed successfully, and a comparison with the pre-change backup showed only those two line changes. The backup is `C:\Users\efso office\Documents\Forge-config-recovery\config-before-strata-200k-20261003.yaml`. Forge must reload to read the updated config, and the managed Strata server receives the new `{num_ctx}` value on its next start. This config change does **not** alter the fixed compaction excerpt or summary limits described above.

## Interpretation and decision points

The strongest directly supported finding is that Forge compressed a long, evidence-heavy audit into a short, incomplete working handoff. The stale memories did not cause the omissions; they were an unsuccessful attempt to recover after the omissions. Claude's observed readable handoffs were several times longer than Forge's 3,018-character summary, but length alone does not measure quality or prove a particular target size is sufficient.

The owner selected an implementation plan covering percentage-based compaction budgets, task-specific memory cleanup, and the bundled `rg` command path. None of those code changes has been made; the live context and threshold config change above is the only change already applied.

## Limits of this investigation

- The active Forge transcript continued to change while it was read. The compaction record and the immediately following recovery sequence are the stable evidence used above.
- The Claude samples are local session records, not a controlled quality comparison using the same task and model.
- Codex's encrypted compaction content cannot be inspected as prose from these records.
- The current Codex desktop memory setting was not queried directly; the local check covered its config file and default memory directory.
- No 100k versus 200k controlled Forge run or earlier 151k successful summary was examined.
- The unrelated working-tree changes shown by `git status` predated this report and were not modified for this investigation.
