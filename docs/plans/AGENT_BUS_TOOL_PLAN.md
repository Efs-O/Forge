# `ask_live_session` — the agent bus as a tool

**Date:** 2026-09-16 · **Status:** implemented in 0.16.4, both targets (Claude via
the watcher, Codex via `codex queue`; see "Codex" below).

## Problem

Forge's agent calls `ask_local_agent` on its own, without being told to. It
never uses the agent bus (`~/.forge/agent-bus/`) on its own, because the bus is
prose in `FORGE.md`, while `ask_local_agent` is a tool in its list on every
turn. The first live test showed the cost. Asked to coordinate with the Claude
Code session that owned the other half of a split task, the agent called
`ask_local_agent`. That opened a **new, empty** Claude session and handed it
work that was already done.

The prose fix only half works:

- The agent has no Bash tool, so it has to build a PowerShell polling loop
  inside `exec_command` every time (one full thinking block the first time).
- Nothing tells it whether anyone is listening. With no live session, the loop
  blocks the whole turn for 20 minutes before it learns that.
- It has to remember to quote the reply.

CLAUDE.md's own lesson applies: when a behaviour matters, fix the tool contract,
not the prose.

## Design

One new tool, `ask_live_session`, in `src/tools/liveSessionTool.ts`
(~150 lines), plus a bus helper, `src/agentBus/agentBus.ts` (~120 lines), which
owns the file protocol.

### Tool contract

| Arg | Type | Notes |
| --- | --- | --- |
| `subject` | string, maxLength 120 | One line. It is all the live session sees first. |
| `question` | string, maxLength 4000 | Bounded, like `ask_local_agent`'s `task`. |
| `wait_minutes` | integer 1–20, default 20 | Ceiling, not a delay. Returns the moment the reply lands. |

- Permission: `delegate`, the same class as `ask_local_agent`. It is the same
  kind of act: asking another agent.
- Honours the turn's `abortSignal`, so `/stop` does not leave a turn parked for
  20 minutes (same pattern as `waitTool.ts`).
- The description states the routing rule where the model reads it at call
  time: *"Use this, NOT ask_local_agent, to reach a Claude Code session that is
  already running and already knows the task. ask_local_agent always starts a
  new, empty session."*
- The **result** is the exchange itself, formatted as Markdown
  (`**Asked Claude:** <subject>` / `**Claude says:** <reply>`), and the tool is
  in `PROSE_RESULT_TOOLS`, so the chat shows it as prose. The agent no longer
  has to quote anything (see "Visibility").

### Knowing whether anyone is listening (new: heartbeat)

The Claude-side watcher also touches `~/.forge/agent-bus/listening` on every
5 s sweep. The tool reads that file's mtime **before** writing anything:

- **One 30 s threshold is too tight** (found during the live test,
  2026-09-16). The Claude-side Monitor expires every 30 min and is re-armed
  only when that session processes the expiry notice. A session busy with its
  user can take well over 30 s to do that, and a single threshold would then
  report "nobody listening" for a live session. Use two thresholds:
  - fresh (< 30 s) → send and wait normally;
  - stale 30 s–3 min → send, but tell the agent the listener may be
    re-arming, and cap the wait at 3 min;
  - older than 3 min, or missing → fail at once (below).
- The heartbeat proves the watcher loop runs, **not** that the session will
  answer quickly. Round 1 of the live test took ~2 min because the session was
  answering its user.
- Older than 3 min, or missing → return immediately:
  `No live Claude Code session is watching the bus. Tell the user; do not fall back to ask_local_agent on your own.`
  This turns a silent 20-minute block into an instant, honest answer.
- Fresh → write the question and wait.

### Advertising, and the prefill cost

Always advertise the tool while `agent_bus.enabled: true` (new config field,
default `false`, validated with Zod). **Do not** gate advertisement on the
heartbeat. A tool list that changes mid-conversation forces a full cold
re-prefill on Qwen3.8 (~95 s at 70K context; see memory
`project_forge_tool_list_cold_prefill`). The heartbeat check lives in the
handler, where it costs nothing.

### Bus paths

Derived from `os.homedir()`, never hardcoded. The bus is outside the workspace
on purpose, so a `workspaceFolders[0]` that is not the repo root cannot move
it.

## Protocol fixes this plan also makes

Both sides have these bugs today:

1. **Partial reads.** The asker writes `inbox/<id>.md` directly, and the Claude
   side writes `outbox/<id>-reply.md` the same way. A 5 s poll can catch
   either one half-written. **Fix:** both sides write `<name>.tmp`, then
   rename. The watcher only globs `*.md`, so it never sees a `.tmp`.
2. **Id collisions.** `date +%s` has one-second resolution, so two questions in
   the same second overwrite each other. **Fix:** the id is
   `<unix-ms>-<4 random hex>`.
3. **Nothing ever deletes anything.** The bus grows without limit. **Fix:** see
   the ledger.

## State × lifecycle ledger

| Artifact | Create | Delete | Disable (`agent_bus.enabled:false`) | Crash mid-write | Owner death | TTL |
| --- | --- | --- | --- | --- | --- | --- |
| `inbox/<id>-forge.md` | tool, tmp+rename | tool, after reading the reply | not written (tool not advertised; handler refuses) | only `.tmp` exists → never seen; swept by TTL | asker dies → question stays; Claude answers into an orphan reply → TTL | tool sweeps >24 h at the start of each call |
| `inbox/<id>-forge.md.notified` | watcher; for `target: codex`, the tool writes it *before* the question so the Claude watcher never answers a Codex question | tool deletes it with the question | n/a | zero-byte, atomic | watcher dies → marker stays → TTL | same sweep |
| `outbox/<id>-reply.md` | Claude, tmp+rename | tool, after reading | n/a | `.tmp` only → tool keeps waiting | asker gone → orphan → TTL | same sweep |
| `*.tmp` (either side) | writer | writer's rename | n/a | **is** the crash case | stays → TTL | same sweep |
| `listening` heartbeat | watcher, every 5 s | never (its mtime is the signal) | n/a | zero-byte touch | stops updating → stale >30 s → tool refuses fast | mtime *is* the TTL |
| Message queued into a Codex thread | tool, via `codex queue` (only after the inbox file exists) | Codex's daemon, when the open session runs it; not Forge's to delete | n/a | `codex queue` fails → tool withdraws the inbox file and reports the stderr | window closed → message waits in Codex's queue; a later reply is an orphan → TTL | none on Forge's side; the question file still gets the 24 h sweep |
| Claude Monitor task | Claude session, on "arm the bus" | TaskStop / session end | n/a | n/a | session ends → heartbeat goes stale (covered above) | 30 min, re-armed |

**Timeout or `/stop` while waiting:** the tool deletes its own inbox file
(the asker is gone, so an answer would be an orphan). If `.notified` already
exists, Claude may be mid-reply; the reply then becomes an orphan, which the
TTL sweep removes. Accepted: 24 h of one small file.

**Late replies are surfaced, never dropped** (agreed with the Forge agent in
the live test, 2026-09-16). An orphan is simply "a reply whose inbox file is
gone", because the tool deleted that inbox file when its wait timed out. At the
start of each call, the tool lists orphans, announces each one **once** in its
result (`A late answer arrived for <id>: …`, at most 3, then `+N more`), and
then deletes it. Nothing is lost unseen, and nothing is announced twice. The
24 h sweep covers a caller that never calls again.

**The wait blocks** until the reply, the `wait_minutes` cap, or `/stop`. It
does not return early with "still waiting": each re-poll would cost a tool
round, and a caller that asked almost always needs the answer before its next
step.

**CI-enforceable row:** after a successful `ask_live_session` call against a
fake reply, `readdir` of `inbox/` and `outbox/` is empty. A later change that
adds a new bus artifact without cleanup fails this test.

## Claude side

- Save the watcher command, with the heartbeat `touch`, in the bus README and
  in memory (`project_forge_agent_bus`), so any session arms it when the user
  says "arm the bus".
- Optional, separate decision: a `SessionStart` hook in `~/.claude/settings.json`
  that injects "arm the agent-bus watcher" into every Forge-project session.
  This removes the last manual step, but every session then listens, including
  ones that have nothing to do with the bus. **Recommend: not yet.** Decide
  after a week of use.

## Visibility: both chats must show the exchange

Found in the live test (2026-09-16). With `ask_local_agent`, the user could
read the exchange in both windows. Forge renders its result as Markdown
(`PROSE_RESULT_TOOLS`, `src/sidebar/toolResultView.ts:44`). The Claude panel
showed the question as the first user message of a new session. Over the bus,
neither window shows it:

- **Forge:** `read_file` renders the reply as raw text in a collapsed row. The
  agent has to copy it into its own answer (`Claude says:`), which is one
  more thing for it to forget.
- **Claude:** the question arrives only as a Monitor notification, which the
  panel does not show as a message. The reply is written inside a tool call.
  The Claude Code CLI (2.1.260) has **no** way to post into a session that is
  already running (`--resume <id> --bg` starts a copy), so the question cannot
  be made a real user message there.

Fix, one per side:

1. **Forge:** add `ask_live_session` to `PROSE_RESULT_TOOLS`. The tool result
   is then an exchange formatted as Markdown:
   `**Asked Claude:** <subject>` / `**Claude says:** <reply>`. It renders in
   the chat like a delegate's answer. The quote-it-yourself rule is no longer
   needed; drop it from the result string.
2. **Claude:** a behaviour, not code. For each bus message, the live session
   writes both sides into its visible reply, verbatim: `**Forge asks:** …` and
   `**I replied:** …`. It does not only summarize. The self-contained arm
   prompt (below) states this, so it also holds for a new user's Claude.

## Distribution: a new user has none of this

Everything that made the first test work is private to one machine: Claude
memory under `~/.claude/projects/...`, a `FORGE.md` that is gitignored, and a
hand-written `README.md` and `watch.sh` in `~/.forge/agent-bus/`. A fresh
install has none of it. The feature only exists if Forge itself ships every
piece. **Rule: nothing in this feature may depend on a user-local instruction
file.**

| Piece | How a new user gets it |
| --- | --- |
| Routing rule ("live session → bus, not `ask_local_agent`") | In the `ask_live_session` tool **description**. Ships in the VSIX, and the model reads it on every turn. No `FORGE.md` line needed. |
| Quote-the-reply rule | In the tool **result string**. Same reasoning. |
| Bus directories, `README.md`, `watch.sh` | Written by `agentBus.ts` from constants in the extension (`ensureBus()`), the first time `agent_bus.enabled` is true. A newer Forge version rewrites them, so the protocol on disk never drifts from the code. |
| Telling the user how to arm Claude | The "nobody is listening" result tells the agent to show the user a **self-contained prompt** to paste into Claude Code (below). Claude needs no memory, because the prompt and the README carry the whole protocol. |
| The same prompt, on demand | Command **`Forge: Copy Claude Bus Prompt`** copies it to the clipboard. |
| Codex as a sender | The README's bash section. The prompt that Forge sends a CLI target through `ask_local_agent` gets one sentence pointing at the README when the bus is enabled. |

### The self-contained arm prompt

Generated by Forge with the real home path substituted, never hardcoded:

```
Watch the Forge agent bus for the rest of this session. Run
`bash "<home>/.forge/agent-bus/watch.sh"` as a background Monitor with the
maximum timeout, and re-arm it whenever it expires. Each INBOX line is a
question from another agent. Read that file, answer it, and write your answer
to `<home>/.forge/agent-bus/outbox/<same id>-reply.md` (write a .tmp file
first, then rename it). In your visible reply, show both sides verbatim:
`**Forge asks:** ...` and `**I replied:** ...`. Full protocol:
`<home>/.forge/agent-bus/README.md`.
```

This works in any Claude Code session that stays open, on any machine, with no
prior setup. Only an interactive session can listen: a `claude -p` run exits
when its turn ends, and its watcher dies with it. The README says so.

### Deliberately NOT done

- Forge does **not** write into `~/.claude/` (memory, commands, hooks) or into
  the user's repo. That is another tool's configuration, and the user did not
  ask Forge to manage it. An opt-in "Install `/forge-bus` command for Claude
  Code" button can come later, as its own decision.
- `watch.sh` needs bash. Claude Code on Windows already requires Git Bash, so
  any machine that can run a listener has bash. The README says this rather
  than shipping a second, PowerShell watcher.

## What changes elsewhere

- `FORGE.md`: the bus bullet shrinks to one line ("to reach a live Claude
  Code session, use `ask_live_session`, never `ask_local_agent`"). The
  PowerShell recipe goes away.
- `README.md` (bus): tmp+rename, the new id format, the heartbeat, and a
  pointer that Forge uses the tool.
- `docs/OWNERS.md`: rows for `src/agentBus/agentBus.ts` and
  `src/tools/liveSessionTool.ts`.
- `CHANGES.md` entry.
- Codex keeps the README's bash loop (it has a shell). It gets the same
  tmp+rename and id rules.

## Codex

Codex cannot run a background watcher, so it cannot listen the way Claude
does. But Codex CLI 0.153.2 has what Claude Code lacks: `codex queue --thread
<id> --message <text>` delivers a message into an existing session through the
shared local app-server daemon. If that message runs in an **open** Codex
session, Codex needs no watcher, and the question appears in its window as a
real message. The reply still comes back as `outbox/<id>-reply.md`.

**Proven live (2026-09-16).** A message queued with `codex queue` shows up in
an open Codex window as a real user message, and Codex acts on it. Codex wrote
the reply file (`.tmp` + rename) about 20 s after the queue call. Conditions
found on the way:

- The session must be **open** in a terminal (`codex resume <thread>`). A
  queued message waits until then; nothing runs it headless.
- It must be resumed with `--sandbox workspace-write --add-dir <bus root>`. A
  session created read-only stays read-only on resume, and its write fails
  with "access denied".
- `codex resume` is an interactive TUI, so only the user can open it (Codex
  itself refused to run it non-interactively).

**Built (0.16.4):** `ask_live_session` takes `target: "claude" | "codex"`.
For Codex it takes a thread id (from `agent_bus.codex_thread` in config, since
the model cannot know it), delivers with `codex queue --thread <id> --message
<question + reply instructions>`, and waits on the same outbox file. Codex
needs no watcher and no heartbeat, but there is also no way to tell whether the
window is open, so the tool can only say "no answer within N min".
`codex queue` runs through `spawnCliProcess` (`shell: false`, the same `.cmd`
shim handling as the CLI delegation adapters) from
`src/agentBus/codexDelivery.ts`, with a 30 s limit. The Codex question is also
written to the inbox, with its `.notified` marker first, so cleanup and late
answers work exactly as for Claude. Config: `agent_bus.codex_thread` and
`agent_bus.codex_cli` (default `codex`).

## Out of scope

- Claude asking Forge (the reverse direction). The Forge agent is only awake
  during a turn.
- More than one listening Claude session. The first to see a file answers it;
  a second can double-reply. Revisit only if that happens.
- Any network transport. It is files only, so it adds no outbound traffic.

## Acceptance criteria

1. With the heartbeat stale, `ask_live_session` returns the "no live session"
   string in under 1 s and writes nothing. *(unit test, fake clock + tmp dir)*
2. With the heartbeat fresh and a reply written by tmp+rename after 2 s, the
   tool returns the reply with the `Claude says:` instruction. *(unit test)*
3. A reply file that exists only as `.tmp` is never returned. *(unit test)*
4. `/stop` during the wait returns within 1 s and deletes the inbox file.
   *(unit test, AbortController)*
5. Two calls in the same millisecond get distinct ids. *(unit test)*
6. After a successful call, `inbox/` and `outbox/` are empty (the ledger's CI
   row). *(unit test, readdir)*
7. Files older than 24 h are swept at the start of a call. *(unit test)*
8. With `agent_bus.enabled: false`, the tool is not advertised and the handler
   refuses. *(unit test)*
9. **Manual, named step:** in the Forge sidebar, with this Claude session
   armed, prompt "ask the live session whether X". The agent calls
   `ask_live_session`, not `ask_local_agent`, **without being told the tool
   name**, and its answer contains a verbatim `Claude says:` block. Repeat with
   the watcher stopped: the agent reports that nobody is listening within one
   round.
10. A reply that lands after a timeout is announced once on the next call,
    then deleted, and a third call does not repeat it. *(unit test)*
11. `ensureBus()` creates `inbox/`, `outbox/`, `README.md` and `watch.sh` in an
    empty home, and rewrites a stale `watch.sh`. *(unit test, tmp home)*
12. **Manual, fresh-profile step:** with a new Windows user profile (or with
    `~/.claude/projects/*/memory` and `FORGE.md` moved aside), install the
    VSIX, enable `agent_bus`, and ask the agent to consult the live session
    with no Claude running. It shows the arm prompt. Paste that prompt into a
    new Claude Code session, ask again, and the exchange completes. **No
    private file may be needed at any point.**
