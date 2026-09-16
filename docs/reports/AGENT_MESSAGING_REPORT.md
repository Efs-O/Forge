# Agent messaging: how Forge, Claude Code and Codex talk to each other

**Date:** 2026-09-16 · **Version:** Forge 0.16.6 · **Design and ledger:**
[../plans/AGENT_MESSAGING_PLAN.md](../plans/AGENT_MESSAGING_PLAN.md)

This report covers three things: what the feature does, what was built today
and why, and what a new machine needs for it to work.

---

## 1. What it does

On one machine you may have three kinds of AI agent open at once:

- **Forge**, the local-model agent in the VS Code sidebar.
- **Claude Code sessions**, which can be several, each in its own window or
  panel.
- **A Codex session** in a terminal.

Any of them can now send a message to another. The message shows up **in the
receiver's own window**, like a normal message. You see both sides without
copying and pasting.

The main use: you split a task between Forge and a Claude session. Forge's
agent can then ask _that_ session, which already knows the work, "does X
still hold?" and wait for the answer. It does not open a new, empty Claude.

## 2. How it works

Each agent has one "front door". The sender doesn't matter to the door; it
only delivers the message.

| Receiver              | Front door                                                                                                                             | What you see                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| A Claude Code session | Claude Code's own messaging channel. Every open session registers itself in `~/.claude/sessions/` and listens on a private named pipe. | A "message from another session" block in that Claude chat, even mid-task. |
| Codex                 | The `codex queue` command, which puts a message into an open Codex session.                                                            | A normal user message in the Codex terminal.                               |
| Forge                 | Two new routes on Forge's local control server, `127.0.0.1:8799`, guarded by a password (a token).                                     | A new chat turn starting **"<name> says:"** in Forge's active chat.        |

### Forge asks Claude a question

1. Forge's agent calls its `ask_live_session` tool.
2. Forge reads the list of open Claude sessions and picks the right one (see
   "Which Claude session?" below).
3. Forge writes the question into that session's pipe. It appears in the
   Claude chat at once. The question ends with a ready-made reply command.
4. Claude answers by running that command:
   `bash ~/.forge/agent-bus/forge.sh reply <id>`.
5. Forge's agent, which has been waiting, receives the answer. The Forge chat
   shows **Asked Claude (name):** … **Claude (name) says:** ….

### Claude or Codex messages Forge first

The sender runs `bash ~/.forge/agent-bus/forge.sh say <its-name>` with the
message text. If Forge is idle, the message starts a turn right away. If
Forge is busy, the message waits (up to 20 in line) and starts when the
current turn ends. To answer, Forge's agent uses `ask_live_session`, naming
that session.

### Forge asks Codex

Forge sends the question with `codex queue`. Codex answers by writing a reply
file in `~/.forge/agent-bus/outbox/`. Codex's sandbox has no network access,
so it can't use `curl`; the file is its route back.

### Which Claude session?

Forge never guesses. In order, it uses:

1. the session the agent names in the call;
2. `agent_bus.claude_session` in `config.yaml`;
3. the only Claude session open in this workspace.

If none of these applies (for example, five sessions are open), Forge sends
nothing. It lists the sessions and asks you to pick one. **Forge: Show Live
Claude Sessions** shows the same list.

### The files involved

Everything lives in `~/.forge/agent-bus/`:

| File                       | What it is                                                                    |
| -------------------------- | ----------------------------------------------------------------------------- |
| `README.md`                | The protocol, written by Forge.                                               |
| `forge.sh`                 | The small script other agents run to reach Forge. Written by Forge.           |
| `endpoint.json`            | Forge's address and current token. The token changes every time Forge starts. |
| `inbox/<id>-forge.pending` | "Forge is still waiting for this answer." Deleted when the question ends.     |
| `outbox/<id>-reply.md`     | An answer delivered as a file (the fallback route, and Codex's route).        |

After a finished exchange, only `README.md`, `endpoint.json`, `forge.sh` and
two empty folders remain. A test enforces this. Anything older than 24 hours
is deleted.

### Safety

- The Forge routes only listen on `127.0.0.1`. Without the token they refuse
  everything. Messages are size-limited: 8,000 characters for a new message,
  32,000 for an answer.
- Forge only _reads_ Claude Code's session list. It never changes Claude
  Code's files or settings.
- A Claude session running with **bypass permissions** holds incoming
  messages for your approval, unless you set
  `"crossSessionInbound": "accept"` in `~/.claude/settings.json`. That choice
  is yours; Forge never sets it. With `accept`, any program running as you
  can type into your Claude sessions. Such a program could already run
  commands as you, so this gives it no new power, only a new route.

## 3. What was done today, and why

**The first version (0.16.4) worked, but it was fragile.** Claude sessions
had to run a background watcher script that checked a mailbox folder every 5
seconds. It had several problems:

- It stopped every 30 minutes (the longest Claude Code allows) and had to be
  restarted. That's where the "listener timed out, I restarted it" messages
  came from.
- Old copies kept running unseen, and one of them swallowed a question.
- Messages never showed up in the Claude chat; Claude had to retype them.
- Only Forge could start a conversation.

**The finding that changed the design:** Claude Code already has built-in
session-to-session messaging. It was proven today in three ways:

- a message sent from another Claude session appeared mid-task;
- a message written straight into the pipe by a small script also appeared;
- a full round trip (question in, answer back through `forge.sh`) took about
  one second.

**Built (commits 654d994, 779abc4, released as 0.16.6 in a290a65):**

- `ask_live_session` now uses Claude's own channel. The watcher, heartbeat
  file, "paste this prompt" step, "Copy Claude Bus Prompt" command and
  start-up hook are all gone.
- New Forge inbound routes (`/agent/message`, `/agent/reply`), the
  `forge.sh` client, and a message queue for when Forge is busy.
- Safe session choice, and the **Show Live Claude Sessions** command.
- An opt-in backup route (`claude_transport: relay`). It hands the message to
  a one-shot `claude -p`, about $0.10 per message, for a future Claude Code
  version whose pipe Forge can't use.
- Pending-question files no longer end in `.md`, so a leftover old watcher
  can never pick them up.
- Tests: pipe framing against a fake Claude inbox, the routes (token, size
  limits, queue), the real `forge.sh` script against the real routes, the
  relay against a fake `claude`, and the "leaves nothing behind" rule.

**Clean-up on this machine:**

- stopped four orphaned watcher processes;
- removed the old start-up hook;
- told the `forge-ef` session to stop restarting its listener;
- set `crossSessionInbound: accept`, at your request;
- pinned `claude_session: forge-dd` in the local config for the first test.

**Also in 0.16.6 (from another session):** `/unload` now frees only the
current chat's model, and `/unloadall` frees everything.

**Limits:**

- The pipe gives no receipt, so Forge can't tell "delivered" from "held for
  approval". If no answer comes, the timeout message explains both
  possibilities.
- Claude Code's session list and pipe format are not officially documented.
  If an update changes them, Forge reports the error clearly; the relay
  route is the workaround.
- Only the Forge window that owns port 8799 receives messages. With two
  Forge windows open, the first one wins.
- Claude's answer appears in Forge as tool output, not as a Claude chat
  bubble. There is no combined "agents' conversation" view.

---

## 4. Setting up a new machine

### Required

1. **Forge 0.16.6 or later**, installed in VS Code.
2. **Forge's `config.yaml`** needs these blocks:

   ```yaml
   control_server:
     enabled: true
     port: 8799

   agent_bus:
     enabled: true
   ```

   Without `control_server`, Claude and Codex can't message Forge. Answers
   to Forge's questions still arrive through the outbox file.

3. **Claude Code** (the VS Code extension or the CLI), logged in. The feature
   was tested with version 2.1.273; older versions may lack the messaging
   channel. Open the Claude session in the same folder as your Forge
   workspace, or name it (next section).
4. **Git Bash with `curl`** (Windows). Claude Code on Windows already requires
   Git Bash, and Git for Windows includes `curl`. On macOS and Linux, bash and
   curl are normally present.
5. **Start Forge once.** On start, Forge creates `~/.forge/agent-bus/` with
   `README.md`, `forge.sh` and `endpoint.json`. You don't create anything by
   hand.

### Recommended

6. **If your Claude sessions run with bypass permissions**, add this to
   `~/.claude/settings.json`:

   ```json
   "crossSessionInbound": "accept"
   ```

   Otherwise each Forge message waits for you to approve it in that Claude
   window. Sessions in normal (prompting) mode don't need this.

7. **If you keep more than one Claude session open in the same folder:** give
   the one Forge should talk to a fixed name with `/rename` in Claude Code.
   Then add it to `config.yaml`:

   ```yaml
   agent_bus:
     enabled: true
     claude_session: my-main-session
   ```

   Session names like `forge-dd` are generated automatically and change when
   a session restarts, so a fixed name saves you from being asked each time.

### Optional

8. **Codex as a target:**
   - Install the Codex CLI and log in.
   - Open the session in a terminal with write access to the bus folder:
     `codex resume <thread-id> --sandbox workspace-write --add-dir "~/.forge/agent-bus"`.
   - Put its thread id in `config.yaml`:

     ```yaml
     agent_bus:
       codex_thread: <thread-id>
       codex_cli: codex # or an absolute path
     ```

9. **Backup route** (only if the pipe route stops working after a Claude Code
   update): add `claude_transport: relay` under `agent_bus`, with `claude` on
   PATH (or `claude_cli: <path>`). Optionally set `relay_model: haiku`. Each
   message costs one short model call.
10. **A workspace hint for Forge's agent** (optional): one line in
    `FORGE.md`:

    > A LIVE Claude Code or Codex session is reached with `ask_live_session`
    > only, never `ask_local_agent`.

    The tool's own description already says this, so the line is a
    reinforcement, not a requirement.

### Not needed any more

- No watcher, no background Monitor, no "paste this prompt into Claude".
- No SessionStart hook. **If you're moving from an older setup,** remove any
  `agent_bus_arm` hook from `.claude/settings.local.json`. Tell any running
  session to stop its `watch.sh` listener, or just restart that session.

### Check that it works

1. In Claude Code, run `bash ~/.forge/agent-bus/forge.sh say test` and type
   `hello` (Ctrl-D ends the input). Forge's chat should show
   **test says:** hello.
2. In Forge, ask: _"Ask the live Claude session what it is working on."_ The
   question should appear in the Claude window. After Claude runs the reply
   command, Forge shows **Claude (name) says:** ….
3. Command palette, **Forge: Show Live Claude Sessions**: your session should
   be listed.

### Troubleshooting

| Symptom                                                       | Cause and fix                                                                                                                            |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `forge.sh`: "Forge is not reachable"                          | Forge isn't open, or `control_server` / `agent_bus` isn't enabled.                                                                       |
| `forge.sh`: HTTP 401                                          | Stale token. Forge restarted; the script re-reads the token on every call, so this usually means another Forge window now owns the port. |
| Forge: "Several Claude Code sessions are open…"               | Name the session in your request, or set `agent_bus.claude_session`.                                                                     |
| Forge: "no message key" / "peer protocol …"                   | Claude Code is too old or too new for the pipe route. Update Claude Code, or set `claude_transport: relay`.                              |
| Question never answered, no error                             | The Claude session is in bypass mode and holding the message. Approve it there, or set `crossSessionInbound: accept`.                    |
| A Claude session keeps saying "listener timed out, restarted" | It is still following the old instructions. Tell it to stop the agent-bus listener, or restart it.                                       |
| Codex never answers                                           | Codex must be open in a terminal with `--sandbox workspace-write --add-dir` for the bus folder, and `codex_thread` must match.           |
