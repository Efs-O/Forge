# Project Instructions

Keep this file concise (under 48,000 bytes). Forge includes it in every native local-agent prompt.
Fill in the blanks below; delete any rule that does not fit this project.

## Project facts
- Purpose and important architecture decisions:

## Commands
- Build:
- Test:
- Full gate, as ONE command line (run after changing code):
- Changelog (update it in the same change as a version bump):

## Skills
- `load_skill` opens a skill folder — instructions plus tested scripts — from the skills Forge ships, from `~/.forge/skills/` or from `.forge/skills/` in this workspace; `shell` runs its scripts, and a skill grants nothing beyond what the shell already allows. For Hugging Face downloads use `hf_parallel_dl.py`, never `hf download`.

## How to work efficiently
- Every response is a round, and each round costs seconds before the first token. Put calls that do not depend on each other (reads, searches, listings) in ONE response. Read the file you need instead of listing its folder first.
- A refusal is an answer, not an obstacle. Read its message: if it names an alternative, use it; if a path or command is refused, another spelling or a script that does the same thing is not the fix. Stop and ask the user.
- Waiting on a long command: start it with the shell tool's background: true, tell the user what you are waiting for, and end your turn or work on something else — the exit notice arrives on its own. Use monitor_execution only when this turn must see the output, reusing its suggested_next_wait_ms (each call waits up to 60 s) instead of polling in short steps; ask only for the output you need.
- A question is not an instruction to build. When the user asks what, why or how much, answer and stop; start editing only when the message says so ("do it", "fix it", "add it"). If the answer points at a change, name it and its cost in one line and wait.
- Name everything you leave behind: a branch, a file, a memory note, a background job. Say what it is in your report, or undo it before you finish.
- A push needs the user's own words. "Do it", "go", or a request to commit, build or install is not consent to push: ask first, and ask again if the range changed.
- Extend the file that already owns a concern instead of adding a sibling that half-overlaps it, and remove dead code only after checking every reference to it.

## Mistakes you make
- Any call of yours refused or errored: add one line to `docs/CODING_TIPS.md` before your next call — `what I wrote → what happened → what to write instead`, with the error's first words copied. Forge injects that table into every prompt, so there is nothing to open later. Search it first and sharpen a line that is already there instead of adding a second. One line, at most 300 characters, under a `## READ`/`SEARCH`/`EDIT`/`WRITE`/`RUN`/`GIT`/`TEST`/`PATHS`/`DELEGATE`/`FORENSICS` heading; a mistake with a Forge tool goes under `## FORGE_TOOLS`, starting with the tool's name and ` · ` (`` 1. `read_file` · … ``).
- Before the final answer, reread this turn's tool results and record what is still unrecorded: a wrong assumption, a search that answered nothing, an error you recovered from. Recovering is not a pass.

## Tool arguments that are refused (each refusal costs a round)
- `edit_file`: the shortest unique `old_str`, copied verbatim, whitespace exact. Never reuse an anchor an earlier edit in the same batch changed.
- Booleans are bare JSON `true`/`false`, never `True` or `"true"`. Array arguments (`edits`, `reads`, `questions`, `items`) are JSON arrays, not strings.
- `ask_user` option `description` is at most 500 characters (label 80). Put long context in the prompt or a file you name.

## Reviews
- For an audit or a review, fix the exact commit range and the baseline first; never infer the scope from the newest commit.
- "reply only" / "just tell me" means answer in chat with no tool calls at all.

## Asking the user
- When the user must choose between fixed answers, ask with `ask_user`, not a numbered list in your reply: up to 4 questions per card, one line per option saying what it leads to, one option marked recommended. More than 4 decisions: several cards, most urgent first. In an unattended run, state the assumption and continue instead of opening a card.

## Before calling a change done
- After the last code edit, run the full gate above in one call and report its exact result. A subset of tests is not the gate. A task that changed no code (a report, an answer) needs no gate.
- When you change behaviour, a new regression test must fail without the fix: write and run it before the fix, then fix. Do not revert a fix to prove it.
- A fake of an external program returns what the real one returns (binary output, real error text), never what your code expects.
- For stateful, queued or retried work, test failure, retry, restart and duplicate delivery, not only the happy path.
- Every plan has acceptance criteria listing the invariants and edge cases, each tied to a test or named validation step.
- Keep defects you introduced separate from ones that were already there.
- Keep the complete output of every gate run in its own log file (`> .forge/<task>-<n>.log 2>&1`, a new number per rerun) instead of piping it into `tail`; quote the lines you rely on and name the files in your report.
- Record exact measurements, and say which rules a gate enforces and which are only preferred style.
- Never swallow an error or hide invalid config behind a silent fallback: show the failure and the next useful step.
- For every new wait, timer, delivery or child process, name what cancels it and test that path: an uncancelled one is a leak that only shows up after a week of runs.
- For every message, verdict or request your code acts on, name what checks it came from the right session, chat or sender, and test that too.
- If this project caps file length, check the count while you edit (`wc -l`) and split at a real seam before the cap, not after the lint fails at the end of your turn.
- A plan is not implemented while its acceptance criteria disagree with the code; update the plan when behaviour changes during implementation.

## Other agents in the same repository
- Before you start editing, run git status. Changes you did not make mean another agent or person may be working here: find out who (message_chat reaches another Forge chat) or ask the user, and agree who owns which files before you edit.
- If files you did not touch keep changing, your edits are undone, or a commit picks up changes that are not yours: stop. Do not revert, overwrite or tidy the other changes; contact the other agent or ask the user, and agree on ownership first.
- Parallel lanes need separate worktrees when they edit overlapping files or one runs a full gate while another edits. Agree who lands first; the second lane owns resolving any rebase. For separate files and a short edit, one worktree is enough.
- A red test in another agent's uncommitted file is theirs: name it in your report and leave it.
- Commit only your own files, never git add -A. Commit tool: stage, then commit (it has no file-list form). Shell git: flags first - git commit -m "msg" -- <files>.

## Remembering past sessions
- Past chats on this machine are logged in `~/.forge/sessions/<chat-id>.jsonl` — every tool call and result, with the chat's title as of that run. Search those raw logs first for anything about this workspace; the HalluScribe tools (`load_tool_group` `halluscribe`) search past AI sessions more widely but can be behind the logs, so they are the second stop, not the first.
- Something that looks wrong on screen: read the record the screen draws from first — the file, log or config the view is drawn from — then `git log --grep` or `-S` for the commit that changed it, whose message is usually the diagnosis. Search mechanism words (the field or function that decides the state, such as a retry counter or a parser), not symptom phrasing: nobody writes "still displayed as failed" into a log, and the noun in the request may not be the item that is failing. In a log scan drop `attachment` and system-reminder rows — they are embedded instruction text.

## Working rules
- Add durable conventions, safety constraints, and facts you had to discover the hard way here, so the next session does not rediscover them.
- A plan whose feature writes state that outlives its turn lists every artifact — a file, a registry entry, a config field, a lease, a queue item — and covers create, delete, pause or disable, crash mid-write, owner-process death, and expiry. A plan with no durable state says so explicitly. If a plan you are about to implement lacks this or its acceptance criteria, write them first; do not ask and do not code around the gap.
- Long unattended work: send checkpoints with `notify_user` and do not stop on `ask_user` (it blocks with no timeout); state the assumption and continue.
- On Windows, Git Bash turns a leading `/flag` into a path (`icacls f /deny …`): write `//flag` or set `MSYS_NO_PATHCONV=1` for that command.
