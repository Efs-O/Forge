# Forge tuning: prompt and tool-surface waste (2026-10-07)

Source: round-by-round reading of Forge's own session logs from two audit runs
(`src/tools` bug audit, Strata Flash-Next IQ3_S, 2026-10-07). The aim is fewer
rounds and prompt tokens that buy nothing, **without** cutting verification.
Quality comes first: no item here may trade a found bug for speed.

**Status:** findings 1–7 shipped in `4dcc72d` (unit tests in
`test/unit/forgeTuningPrompt.test.ts`; the bench template matches the builtin
byte for byte). The lazy-groups header comment shipped in `6ee34e9`. Still open:
the rest of the checklist below.

## Findings and decisions

0. **Foreign reasoning in two rounds of run 2** (rounds 16 and 36: "the user
   hasn't asked anything… deferred tools listing and agent types").
   *Not a Forge or server bug.* The same text appears in nine session logs
   since 2026-09-16, including one served by llama.cpp on a different quant, so
   it is neither Strata slot bleed nor Forge logging. It is a pattern in the
   Flash-Next weights; the tool calls in those rounds stay coherent. No change.
1. **`search_code`'s `include` description hardcodes a machine path**
   (`N:\Strata\serve\…`) as its out-of-workspace example. Replace it with
   generic wording. (No-hardcoded-paths rule.)
2. **Citations cost re-reads.** `read_file` is unnumbered by default; an audit
   then spent rounds grepping for line numbers it had already read. Keep the
   default off (numbered reads have broken the edit that follows before, see
   `editMatch.ts`), and say in `numbered`'s description to pass it when the
   answer will cite line numbers.
3. **Nested-root warning when there is no nesting.** The system prompt always
   says paths resolve "from this root, not a nested project directory" and to
   keep the nested prefix; on a workspace that *is* the project that sends the
   model looking for a prefix that does not exist. Make the line conditional on
   a host-computed `workspaceIsProjectRoot` (the root holds `.git` or
   `package.json`): then say the root is the project root; otherwise keep the
   current instruction. Per-parameter notes stay (CLAUDE.md rule).
4. **Final-answer format vs the user's format.** "At most 8 lines… one line per
   finding" overrides a user who asked for file, line, input, effect and
   evidence per bug. Add: if the user specified a format, follow theirs exactly.
5. **Unattended turns learn the gate by failing.** A run tried `rm -rf` on its
   scratch files, was denied by unattended policy, then spent rounds working out
   the alternative. Tell the model up front, in the turn-context block (Layer C,
   only when the conversation is unattended): dangerous commands are denied, not
   sent for approval, and so is a recursive `delete_file`; remove created files
   one by one with `delete_file`, batched in one round. Withhold `ask_user`
   from unattended turns (nobody can answer it; it waits with no timeout) and
   refuse it at dispatch with that reason if called anyway.
6. **Duplicated prompt text.**
   - Template line "If native tool calling is unavailable, emit exactly one json
     block…": `withFallbackToolInstructions` injects the full fallback contract
     exactly when it applies. Remove the template copy.
   - Template line "Turn context may include the user's terminal commands…":
     `renderUserTerminalCommands` carries the same guidance whenever there are
     commands. Remove the template copy.
   - Kept on purpose: `write_file`'s split rule in both the description and
     `content` (about 30 tokens, and truncated writes are the costliest failure
     this repo has measured), `list_directory`'s progress tip, `monitor_execution`'s
     silent-job tip, `load_tool_group`'s roster. Each encodes a measured
     failure, and the roster is how the model discovers lazy tools.
7. **Shell environment facts the model probed for.** One run spent rounds
   locating "the rg the search tools use" and reconciling bash's `/tmp` with the
   path Node sees. The shell description says: `rg` on PATH is the same binary
   `search_code`/`find_files` use; and, for bash on Windows only, that bash's
   `/tmp` is not a path Windows programs (node, git for Windows) resolve the
   same way, so scratch files belong in a workspace-relative directory.

## Deferred (measure after the next bench round)

- Reading every named file in the first round (behaviour change).
- One probe file / running existing tests early (behaviour change).
- Per-finding scoring and more reps in the grader (bench tooling, not Forge).
- **`update_plan` nudge.** The tool is eager and unchanged since 0.16.90, and
  the prompt has never asked for it; only its description does. On 2026-10-07
  the 0.17.0 sessions planned on larger tasks (7–8 items, about three updates
  each) and skipped it on small ones. Its value is surviving compaction: the
  plan is re-sent in the turn context every round and the resumed agent is told
  to check it. Its cost is a round per call. Nobody has compared planned and
  unplanned runs, so nothing changes yet: record `update_plan` calls per bench
  run alongside the grade. Only if planned runs clearly grade better, add one
  sentence to the tool's description ("call it first when the task has 3+
  steps"), not to the template, so the cost lands only where it applies.

## Open checklist (2026-10-07)

### Before installing 0.17 in the user's main window

- [ ] Add `tool_groups: { eager: [agents] }` (consider `media` and `memory` too,
      per the group-load audit below) under `defaults` in
      `.forge/config.yaml`. `SHELL_TOOL_AND_CORE_GROUP_PLAN.md` grouped
      `ask_live_session`, `tell_live_session`, `ask_local_agent`,
      `list_delegation_targets`, `manage_jobs` and `notify_user` on the
      assumption this key would keep them eager in real use (264 / 100 / 95 /
      56 historical calls); the config never got it. Without it, every remote
      conversation pays one extra round plus a full re-prefill to load the
      group. Add it only after 0.17 is installed: 0.16 may reject the unknown key.
- [ ] Leave the bench config without it, so the bench keeps the lean first
      request.
- [x] Fix the header comment in `src/tools/lazyToolGroups.ts`: it still says the
      high-use tools "stay eager", but the same change moved them into `agents`.
      Say they are grouped and kept eager through `tool_groups.eager`.

### Group-load audit (2026-10-07, 69 session files since the grouping commit)

- **`files`:** loaded in 7 sessions. None of the loads was wasted. Every
  session used `delete_file` or `append_file` from it, and both have since
  been made eager (16:27 and 21:44 the same day). On the current build,
  `apply_line_edits` is the only reason left to load it. After a deliberate
  load it succeeded 4 of 4 times. In the 0.16.90 baseline, where it was eager,
  it succeeded 1 of 4 (two stale `expected_lines`, one array sent as a string).
  Decision: keep it grouped. It costs a load in about 1 session in 20, and
  having it always visible did not make it work better.
- **`git` / `background`:** grouped on purpose (`SHELL_TOOL_AND_CORE_GROUP_PLAN.md`:
  `shell` replaces the git tools; waiting goes through `monitor_execution` and
  shell background). Neither group has been loaded since, while the shell ran
  14 git write commands in 6 sessions, 20 sleeps, and 18 `monitor_execution`
  calls. The shell covers both, so no change.
- **`media` / `memory` / `agents`:** loaded in 3 sessions each, all from the
  user's own workflow (Telegram images, memory, live sessions), none on the
  bench. For the main window, put them under `tool_groups.eager`, not in code.
- No load in the window was speculative, so purpose lines are about
  *discovery* (a tool the model never knew to look for), not about cutting
  wasted loads.

### Grouping rule: a hidden tool's zero calls is not evidence

The "10+ calls stays eager" rule in `lazyToolGroups.ts` cannot promote a tool
that was never visible: its call count is zero by construction. The
`render_html_to_image` case showed it — grouped, and described as not
supporting JavaScript, so a JS page could never reach it. Cheapest first:

- [x] **Count calls only while visible.** The audit divides calls by sessions
      whose `tools_offered` row lists the tool. A tool never offered reports
      "unmeasured", not 0, and an unmeasured tool cannot be cited to keep it
      grouped. Write this into the rule comment and the tool-audit method.
      Done: `tool-visibility-audit.mjs` uses `tools_offered` for the denominator.
- [x] **Count workarounds.** An audit script maps shell commands to the hidden
      tool they stand in for (`npm i three` / `puppeteer` / `playwright` → page
      preview; `git commit` → `commit`; …). A bench run installed `three` into
      Node and counted meshes to "check" a page — a homemade preview, because no
      real one was visible. A tool that is often worked around is promoted with
      zero calls.
      Done: whole-token shell and logged Node-script matches count hidden-session demand.
- [x] **Purpose lines for groups.** `load_tool_group` describes groups by member
      names only, except `halluscribe`. Add a short job description per group
      (`GROUP_PURPOSE` in `src/tools/toolGroupTools.ts`), so a grouped tool is
      found by what it does. A few tokens per turn. Done: typed by
      `NATIVE_LAZY_GROUP_NAMES`, so a group without one fails to compile;
      about 130 tokens, inside the 450-token discovery budget.
- [x] **Exclude self-ruled-out tools.** A tool whose own description says it
      does not apply to the case (e.g. "JavaScript not supported") is not
      counted for that case; its count says nothing about demand. The audit
      notes such descriptions instead of counting them.
      Done: restrictive description sentences appear as notes, separate from counts.

### Visibility audit (2026-10-08)

(The script was replaced on 2026-10-09 by the `tool_usage` job check, `src/sessions/toolUsage.ts`, which writes the same counts daily to `~/.forge/tool-usage/`.)

`node scripts/tool-visibility-audit.mjs --since 2026-10-01`: 118 sessions with activity; calls count only while offered, and workaround counts exclude sessions that offered the target tool.

| Tool | Sessions offered | Sessions called | Calls | Failures | Hidden workaround calls (sessions) |
| --- | ---: | ---: | ---: | ---: | ---: |
| `create_directory` | 32 | 1 | 5 | 2 | 12 (5) |
| `move_file` | 32 | 1 | 1 | 1 | 10 (5) |
| `delete_file` | 36 | 15 | 52 | 3 | 7 (7) |
| `commit` | 25 | 3 | 5 | 0 | 6 (3) |
| `render_html_to_image` | 1 | 0 | 0 | 0 | 1 (1) |
| Background wait (no dedicated tool) | unmeasured | unmeasured | unmeasured | unmeasured | 2 (2) |

The renderer's image mode says it runs no JavaScript; that mode constraint is a note, not a demand count.

## Out of scope

Anything that reduces verification or caps rounds.

## State × lifecycle ledger

No durable state: every change is prompt text, a tool description, or a
per-turn in-memory decision (`workspaceIsProjectRoot`, the unattended flag read
from the existing in-memory registry). The checklist's `tool_groups.eager`
entry is a value in the user's own config under a key that already exists
(`SHELL_TOOL_AND_CORE_GROUP_PLAN.md` owns it), not a new artifact; the audit
changes are scripts and comments. Nothing here outlives a turn.

## Acceptance criteria

- No machine-specific path in any tool description (`dirTools.ts`).
- `read_file`'s `numbered` description names citing line numbers as the reason
  to pass it; the default stays off.
- The rendered system prompt for a workspace with `.git` or `package.json` at
  its root says the root is the project root and carries no nested-prefix
  instruction; one without either keeps the nested-prefix instruction. Covered
  by a unit test on the template.
- The final-answer rule defers to a user-specified format.
- An unattended conversation's turn context states the denial policy, its tool
  list omits `ask_user`, and a call to `ask_user` there is refused with a reason.
  Attended conversations are unchanged. Unit-tested.
- The template no longer carries the fallback-format or terminal-context lines.
- The shell description says `rg` is the search tools' binary, and on Windows
  bash warns about `/tmp`.
- The bench template (`templates/S/execute.njk`, outside this repo) mirrors the
  builtin template.
- Checklist: every lazy group has a `GROUP_PURPOSE` line, and the
  `load_tool_group` description test asserts it, so a new group without one
  fails CI.
- Checklist: the grouping-rule comment in `lazyToolGroups.ts` and the
  tool-audit method say a never-offered tool is "unmeasured", not 0, and that
  workarounds and self-ruled-out descriptions are counted as described above.
- `npm run ci` and `npm run package` are green.
