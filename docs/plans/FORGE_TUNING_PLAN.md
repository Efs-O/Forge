# Forge tuning: prompt and tool-surface waste (2026-10-07)

Source: round-by-round reading of Forge's own session logs from two audit runs
(`src/tools` bug audit, Strata Flash-Next IQ3_S, 2026-10-07). The aim is fewer
rounds and prompt tokens that buy nothing, **without** cutting verification.
Quality comes first: no item here may trade a found bug for speed.

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

## Out of scope

Anything that reduces verification or caps rounds.

## State × lifecycle ledger

No durable state: every change is prompt text, a tool description, or a
per-turn in-memory decision (`workspaceIsProjectRoot`, the unattended flag read
from the existing in-memory registry).

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
- `npm run ci` is green.
