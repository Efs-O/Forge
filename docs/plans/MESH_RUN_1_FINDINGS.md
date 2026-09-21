# Mesh run 1: findings and follow-up fixes

**Date:** 2026-09-21. **Builds:** 0.16.15 to 0.16.18. **Status:** F1 to F3 implemented in 0.16.19; F4 open.

**Run:** Forge (Qwen3.8-27B Q4_K_XL, local), Claude Code (joined as `claude`)
and Codex (a Forge-owned session) built `forge.sh who` (AGENT_MESH_PLAN §11)
with nobody steering them.

**Commits the run produced:**

- `0ed2869`: the feature (Qwen).
- `e47976a`: usage fix (Qwen).
- `6c8d4ad`: usage nit (Claude).

Pipeline fixes made during the run:

- `1bd4783`: consent dialog removed.
- `e48a262`: Telegram mid-turn pairing.
- `633975f`: live-session answers mirrored to Telegram, and the session log
  flushed every round.

## 1. Verdict

The mesh worked end to end. Qwen took the task from brainstorm to plan,
implementation, a cross-agent review, fixes and clean commits. It asked for
help once (a design question to Claude) and never needed a steer. The result
is correct: `npm run ci` was re-run independently and passed (2,848 tests).
Codex's review caught three real defects before the commit.

It was not efficient. The run took 139 minutes of active time for about 660
lines, tests included; a single cloud agent needs about 20 minutes for the
same work. Most of that cost comes from three mechanisms that can be fixed
(section 4), not from the model.

## 2. Measurements

**Sources:**

- Qwen: `~/.forge/sessions/a1e5850e-….jsonl`, deduplicated by row hash as
  CLAUDE.md requires.
- Codex: its rollout `token_count` for the owned session.

**Qwen (turn 1):**

| Metric | Value |
|---|---|
| Active time | 139 min (`active_time_ms` 8,348,132) |
| Model requests | 142 |
| Tool calls | 179 |
| Input tokens | 11.0M. The context is re-sent every round and served from llama-server's prefix cache, so the cost is GPU time, not money. |
| Output tokens | 185K |
| Reasoning | 547K characters, about 140K tokens, so about 75% of output. |
| Visible answer text | 1.8K characters |

**Codex:** one design answer and two reviews. About 115K new input tokens
(1.79M counting the prompt cache) and 18K output tokens. Best value per token
in the run.

**Claude:** not measurable from inside the session. It was the largest cloud
cost, and most of it went on pipeline work (steer, mirroring, log flush), not
on this task.

**Where Qwen's tool calls went:**

| Tool | Calls |
|---|---|
| `read_file` | 44 |
| `exec_command` | 32 |
| `edit_file` | 29 |
| `search_code` | 23 |
| `run_build` | 8 |
| `ask_live_session` | 6 |
| `update_plan` | 6 |
| others | 31 |

## 3. Interventions

| # | Who | What | Avoidable? |
|---|---|---|---|
| 1 | User | Clicked the consent modal for the first owned Codex session. | Yes. Removed in `1bd4783`. |
| 2 | Claude | Answered Qwen's design question (the who verb's columns). | No. This is the mesh working as intended. |
| 3 | Codex | Review found three defects: foreign owner reported as `owned`, a malformed `owner_host` reported as `dead`, a throwing liveness check giving HTTP 500. | No. This is the review step paying for itself. |
| 4 | Claude | Found the `usage()` line range cutting off the help text, and sent it to Qwen. | The finding, no. Sending it to Qwen, yes: finding F2. |
| 5 | Claude | Fixed the leaked comment in the usage output itself (`6c8d4ad`). | No. A one-line fix done by the reviewer is the right route. |
| 6 | (none) | A stale queued note started a 4-minute Qwen turn whose only output was "already done". | Yes: finding F3. |

## 4. Findings

### F1: The `forge.sh` script lives inside a TypeScript template

`CLIENT_SCRIPT` is a `String.raw` template literal in `busContent.ts`. Bash's
`${1:-}` is a template interpolation there. Qwen wrote it naturally and hit
five failed type-check rounds (TS1434, TS1005, TS1127, TS1109) before it
understood why. The workaround comment it then had to write ("VERB is $1 (not
the default-value form)…") shows the trap is structural. Every agent that
edits the script pays it again, and the file cannot be run through
`bash -n` or shellcheck.

**Fix:** move the script to `src/agentBus/forge.sh`, a real file. esbuild
bundles it as text (`loader: { '.sh': 'text' }`), and vitest gets a matching
transform. `.gitattributes` pins `*.sh` to LF, and the loader also strips any
CR as a second guard, because a CRLF bash script fails with `$'\r'`.

### F2: Small follow-ups were routed to the slowest agent

The usage fix was one line. Sent back to Qwen, it cost about 45 minutes: a
full explore, test, CI, commit loop at local speed, plus three scratch
scripts. Codex does the same in about 2 minutes, and so does the reviewer
that found it.

**Fix:** a routing rule in both documents the agents read.

- **`BUS_README`, for Claude and Codex:** a reviewer applies a small fix itself
  or hands it to `codex`. It does not send it back to Forge.
- **`FORGE.md`, for Qwen:** review findings that are small, about 20 changed
  lines or fewer in files already reviewed, go to `codex` via
  `ask_live_session`. Qwen does not spend its own rounds on them.

This is a prompt rule, and CLAUDE.md warns against those. It applies here
because the cause is measured, not guessed: the same edit at 45 minutes
against about 2.

### F3: A queued message cannot be withdrawn

Claude queued a follow-up note with `forge.sh say`, then sent the same request
as an answer to Qwen's blocking question. Qwen did the work in that turn. The
queued note still started a new turn afterwards, which re-derived that the
work was done and blocked on Claude for an acknowledgement. The inbox has no
ids and no way to remove an item.

**Fix:** queued inbox items get an id, which `POST /agent/message` returns.
`forge.sh cancel <your-name> <id|all>` calls `POST /agent/cancel`, which
removes the sender's own items that have not started yet. A message that is
already running cannot be cancelled; that is what `steer` is for. Scope is
Forge's inbox only. Messages relayed to Claude or Codex queues are out of
scope.

### F4: Recorded, no fix yet

- **Reasoning is 75% of Qwen's output.** Lowering the reasoning budget for
  implementation rounds is a candidate, but not a rule. Measure first: vary
  it on one task while keeping the KV quant fixed (see CLAUDE.md, "Weight
  quant and KV quant are two variables").
- **`forge.sh who` parses JSON with `sed` and `awk`.** It is safe for today's
  compact output and breaks if `detail` ever contains `},{` or `]`. Once F1
  lands, the script is a real file and can move to a more robust parser.
- **Telegram was silent for the whole run.** Fixed in 0.16.17 (the answer
  mirror and the mid-turn pairing), but not live-verified yet. Check it on
  the next run.

## 5. State × lifecycle ledger

These fixes write no new durable state.

- **F1** changes where the script's source lives. `ensureBus` still writes the
  same `~/.forge/agent-bus/forge.sh` on every start, and its create and
  overwrite lifecycle is unchanged.
- **F3's queue ids** live in memory only, like the inbox itself: a reload
  drops the queue, and the ids go with it.
- **F2** is documentation.

## 6. Acceptance criteria

- **A1.** `src/agentBus/forge.sh` is a real file. `CLIENT_SCRIPT` is imported
  from it, and the bundled extension writes byte-identical content to
  `~/.forge/agent-bus/forge.sh`. A test covers this.
- **A2.** The script uses `${1:-}` again, with no workaround comment. `bash -n`
  passes on it, and the test is bash-gated.
- **A3.** `CLIENT_SCRIPT` contains no `\r`, even if the file is checked out
  with CRLF.
- **A4.** `POST /agent/message` to Forge returns `{ queued, id }`.
- **A5.** `POST /agent/cancel?from=X&id=Y` removes X's queued item Y and
  returns `{ cancelled: 1 }`. It returns 404 when Y is unknown, already
  started, or someone else's. With `id=all` it removes all of X's queued
  items.
- **A6.** `forge.sh cancel <me> <id|all>` exists, and the usage block and
  README document it.
- **A7.** `BUS_README` and `FORGE.md` carry the small-follow-up rule, and the
  stale "one-time consent" wording is removed from both.
- **A8.** `npm run ci` and `npm run package` pass.
