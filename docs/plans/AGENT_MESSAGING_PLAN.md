# Agent messaging: Forge ↔ Claude ↔ Codex, visible in every window

**Date:** 2026-09-16 · **Status:** approved and implemented (unreleased, all
four phases; see "As built") · **Replaces:** the
Claude half of [AGENT_BUS_TOOL_PLAN.md](AGENT_BUS_TOOL_PLAN.md) (watcher,
heartbeat, arm prompt, SessionStart hook).

## Why

The 0.16.4 agent bus works but leans on the weakest piece in the setup: a
background watcher inside the Claude session. It expires every 30 min, dies
with the session, leaked a loop that swallowed a question, and its events are
never shown in the Claude chat. Only Forge can start an exchange, and nothing
shows up in the Claude window unless Claude re-types it.

Claude Code already has what the watcher imitates. It was proven on
2026-09-16 (Claude Code 2.1.273).

## What was proven

| Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Evidence                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every interactive Claude session registers itself in `~/.claude/sessions/<pid>.json` (`name`, `cwd`, `status`, `kind`, `messagingSocketPath` = a named pipe `\\.\pipe\LOCAL\cc-msg-<32 hex>`, `peerProtocol: 1`).                                                                                                                                                                                                                                                                                                                                                                                       | read directly                                                                                                                                                               |
| Another Claude session's `SendMessage` reaches it over that pipe, **mid-turn, with no watcher**, and it is shown in the chat as a `<cross-session-message from-name=… from-mode=…>` block.                                                                                                                                                                                                                                                                                                                                                                                                              | PING-3 arrived during a tool call                                                                                                                                           |
| Delivery is gated by the documented setting `crossSessionInbound` (`accept` / `hold` / `refuse`). Unset, a message is delivered only when the sender's permission class matches the receiver's (bypass ↔ bypass, prompting ↔ prompting). Otherwise it is **held**: a warning shows in the transcript, plus an approve/deny dialog.                                                                                                                                                                                                                                                                      | PING-1, -2 and -4 (default-mode senders → a bypass session) were held; PING-3 (bypass sender) was delivered. VS Code log: `held inbound peer message (cause=mode-mismatch)` |
| A `claude -p --model haiku --allowedTools SendMessage` relay costs **≈ $0.10 and 6.5 s per message** (≈ 140 k tokens, mostly cache: CLAUDE.md, memory, tool schemas).                                                                                                                                                                                                                                                                                                                                                                                                                                   | `--output-format json` usage                                                                                                                                                |
| Wire format, read from the 2.1.273 binary (undocumented): connect to the pipe; write `{"type":"auth","token":<peerToken>}\n`, where `peerToken` comes from `~/.claude/sessions/<pid>.<sha256(pipe)>.key`, then one JSON line `{msgV, msg_id, type:"user", message:{role:"user", content:"<cross-session-message …>body</cross-session-message>"}, priority:"next", from:<sender address>}`. `from-mode` is honoured only from the host's own stdin, so a pipe sender counts as "no mode asserted": delivered to a prompting session, **held** at a bypass session unless `crossSessionInbound: accept`. | binary strings                                                                                                                                                              |
| `codex queue --thread <id> --message <text>` shows up as a visible user message in an open Codex TUI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 0.16.4 live test                                                                                                                                                            |
| Forge's `SidebarProvider.submitPrompt(text)` → `submitExternal` starts a real, visible Forge turn (the path `/review` and editor commands use). The control server (`src/backend/ControlServer.ts`) is bound to 127.0.0.1 and has **no auth**.                                                                                                                                                                                                                                                                                                                                                          | code                                                                                                                                                                        |

## Design

Every agent gets one inbound door that shows the message in its own window.
Who sends a message does not matter to the door.

| Recipient      | Door                                                                                 | Visible in its window?                          |
| -------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------- |
| Claude session | Claude Code peer pipe (native)                                                       | yes, as a cross-session message                 |
| Codex session  | `codex queue` (native)                                                               | yes, as a user message                          |
| Forge          | **new** authenticated `POST /agent/message` on the control server → `submitExternal` | yes, as a user message labelled with the sender |

Senders:

| From → To              | How                                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Forge → Claude         | `ask_live_session` (`target: claude`) through a `PeerPipeTransport` (below)                                       |
| Forge → Codex          | unchanged (`codex queue`)                                                                                         |
| Claude / Codex → Forge | `curl` to `/agent/message` with the token (Forge writes the recipe into `~/.forge/agent-bus/README.md`)           |
| Claude ↔ Codex         | Claude runs `codex queue` from Bash; Codex runs `curl` to Forge, or a `claude -p` relay (documented, costs money) |

### Replies to a waiting Forge call

`ask_live_session` keeps blocking, as it does now. The message it sends ends
with: _"Reply with `curl … /agent/reply` (id `fg…`)."_ The endpoint writes
`outbox/<id>-reply.md` (tmp + rename). The existing `waitForReply`, orphan and
TTL code stays as it is: it is already tested, and it survives a window
reload. The endpoint is just a new writer for a file the tool already reads.

### Forge → Claude transport

`src/agentBus/claudePeer.ts` (new), one interface, two implementations:

1. **`PeerPipeTransport` (default).** Reads the registry, picks the target
   (by name, or the only live interactive session whose `cwd` is this
   workspace), checks the pid is alive and `peerProtocol === 1`, and writes
   the two frames. Costs nothing and takes milliseconds. Any refusal
   (`auth`, protocol version, pipe gone) is returned to the model in the
   tool result with its reason; nothing falls back silently.
2. **`RelayTransport` (opt-in, `agent_bus.claude_transport: relay`).** Runs
   `claude -p --model <agent_bus.relay_model> --allowedTools SendMessage`
   with a two-line prompt. It uses only documented features, and it is the
   escape hatch if (1) breaks on a Claude Code update. ≈ $0.10 per message.

Liveness comes from the registry (pid alive, `status`), so the `listening`
heartbeat, `watch.sh`, the arm prompt, the "Copy Claude Bus Prompt" command
and the SessionStart hook all go.

### The one setting the user must choose

A Forge message counts as "no mode asserted". A Claude session that runs in
bypass mode therefore **holds** it for approval unless the user sets
`"crossSessionInbound": "accept"` in `~/.claude/settings.json`. Forge never
writes it. When the send reports "held", the tool result tells the user their
two choices: approve in the dialog, or set it. A session in prompting mode
needs nothing.

Trade-off, stated plainly: `accept` lets any process running as this user
put text into a bypass session. Any such process can already run commands as
the user, so this adds no new capability. It does add a new _path_, so the
default stays the user's call.

### Forge inbound endpoint

- `POST /agent/message {from, text}` and `POST /agent/reply {id, text}` on the
  existing 127.0.0.1 control server, as a new route file
  (`src/backend/agentRoutes.ts`) so `ControlServer.ts` stays small.
- Auth: `Authorization: Bearer <token>`. The token is 32 random bytes in
  `~/.forge/agent-bus/endpoint.json` (`{url, token}`, mode 0600), rotated on
  every activation. Without it the answer is 401. These are the first
  prompt-injecting routes, so the auth is not optional.
- `/agent/message` while Forge is idle: `submitExternal("**<from> says:** …")`,
  which starts a turn. While busy: queued (cap 20, then 429) and submitted
  when the turn ends. `from` is a label only; it grants nothing.
- Bounded input: `text` ≤ 8 000 chars, `from` ≤ 40 chars `[A-Za-z0-9 ._-]`.

### Visibility, per window

- **Claude:** the incoming message is shown natively, and Claude's `curl` reply is a visible tool call.
- **Codex:** incoming messages are shown natively, and its `curl` is a visible command.
- **Forge:** outgoing messages are the `ask_live_session` call and result (already rendered as prose). Incoming messages are a visible user turn labelled with the sender.

**What cannot be done:** a Claude reply is not shown as Claude's _chat text_
in Forge. It is shown as the tool result or turn text (it is the same
words). Claude's _own_ outgoing message is a tool call in its window, not a
chat bubble. Neither UI has a split "conversation between agents" pane; that
would be a Forge webview feature (a filtered view of these turns), and it is
out of scope here.

## State × lifecycle ledger

| Artifact                                      | Create                                                                              | Delete                                               | Disable (`agent_bus.enabled: false`)                   | Crash mid-write                                                                    | Owner death                                       | TTL                                  |
| --------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------ |
| `endpoint.json`                               | Forge activation, tmp + rename, 0600                                                | Forge deactivate                                     | not written; routes answer 404                         | tmp only → clients see the old file → 401 → the README says "reload Forge"         | stale token → 401                                 | rotated each activation              |
| `outbox/<id>-reply.md`                        | `/agent/reply` (tmp + rename)                                                       | tool after reading (unchanged)                       | route 404                                              | unchanged                                                                          | orphan → next call, once                          | 24 h sweep (unchanged)               |
| Inbound queue (memory)                        | `/agent/message` while busy                                                         | drained at turn end                                  | 404                                                    | lost with the process; the sender got 202 → documented as "best effort while busy" | lost                                              | cap 20                               |
| Peer pipe message                             | `PeerPipeTransport`                                                                 | Claude Code                                          | tool not advertised                                    | half frame → receiver rejects the frame                                            | receiver dies → connect fails → tool says so      | Claude Code holds it ~1 week if held |
| `inbox/<id>-forge.md` (pending record)        | tool, before delivery (tmp + rename)                                                | tool: on answer, on failed delivery, on timeout/stop | tool not advertised → never written                    | tmp only → the question counts as withdrawn                                        | turn dies → next call sees the reply as an orphan | 24 h sweep                           |
| `forge.sh`, `README.md`                       | `ensureBus` (on activation when enabled, and each call), rewritten when they differ | never (they are the protocol)                        | left in place; `forge.sh` then reports "not reachable" | rewritten next time                                                                | —                                                 | none                                 |
| `.notified`, `listening`, `watch.sh` (0.16.4) | never again                                                                         | `ensureBus` deletes them on sight                    | —                                                      | —                                                                                  | —                                                 | —                                    |
| SessionStart hook (local, gitignored)         | never again                                                                         | removed by hand from `.claude/`                      | —                                                      | —                                                                                  | —                                                 | —                                    |

CI row: `AgentRoutes.test.ts` enumerates the bus folder after a full
exchange and fails on anything other than `README.md`, `endpoint.json`,
`forge.sh` and the two (empty) folders.

## As built (what changed while implementing)

- **The pipe transport was proven with a raw frame, not only SendMessage.**
  PIPE-TEST-1 (a Node script: auth line + frame) showed up in this session's
  chat at once. The key file is `<pid>.<sha256(pipe path)>.key`, and Claude
  Code **lower-cases the pipe path on Windows** before hashing (the raw path
  hashes to a file that does not exist). The receiver sends no receipt, so a
  held message is indistinguishable from a delivered one on the wire;
  criterion 5 is met by the timeout text instead of an up-front "held".
- **Picking a session never guesses.** Seven live sessions shared this
  workspace's folder during the build. The tool picks by `session` argument,
  then `agent_bus.claude_session`, then "the only non-SDK session in this
  workspace". Anything else returns the list and asks the agent to ask the
  user. Command **Forge: Show Live Claude Sessions** shows the same list.
- **`forge.sh` is shipped next to the README.** Asking an agent to hand-build
  a curl call with a token read out of JSON is the kind of step the manual
  bus failed on. `forge.sh reply <id>` / `forge.sh say <name>` read stdin or a
  file. `reply` falls back to the outbox file, so an answer lands even with
  the control server off. The live test caught `say` posting to the wrong
  route, so a test now runs the real script against the real routes.
- **`inbox/<id>-forge.md` stays**, as the "still waited on" record that stops
  `takeOrphans` from claiming a reply that is on time. No watcher reads it
  any more; `.notified`, `listening` and `watch.sh` are deleted on sight.
- **Routes take plain text** (`?from=` / `?id=` in the query) as well as
  JSON. An answer may be 32 000 chars; a new message 8 000.
- **Codex keeps the file reply.** Its `workspace-write` sandbox has no
  network, so `curl` to Forge would fail inside it.

## Phases

1. **Endpoint** (`agentRoutes.ts`, token file, queue, tests). Claude/Codex →
   Forge works. Nothing is removed yet.
2. **`PeerPipeTransport`** plus a registry reader, and `ask_live_session`
   sends through it. Watcher, heartbeat, arm prompt, command and hook are
   deleted. README rewritten.
3. **`RelayTransport`** behind config, with a test using a fake `claude`
   executable.
4. **Docs:** CHANGES, OWNERS rows, example config, FORGE.md one-liner, and
   memory.

## Risks

- **The pipe format is undocumented.** It carries a version (`peerProtocol`),
  and the transport refuses anything but `1`, with a message naming the
  relay setting. Worst case is a clear error, never a silent drop.
- **More than one Forge window:** only the window that owns the control
  server port gets `/agent/message`. That is the same constraint as `/models`
  today.
- **Registry format** (`~/.claude/sessions/*.json`) is also undocumented.
  Forge only reads it, parses it with a tolerant Zod schema, and never
  writes to it.

## Acceptance criteria

1. With a Claude session open (no watcher, no hook), "ask the live session X"
   in Forge reaches it within 2 s and shows in the Claude chat.
2. Claude's `curl … /agent/reply` returns the answer into the waiting Forge
   call, which renders **Asked Claude / Claude says**.
3. Claude sends to Forge unprompted: Forge, while idle, starts a turn showing
   **forge-dd says:** …; while busy, it does so right after the turn ends.
4. Codex sends to Forge and Forge sends to Codex, both visible.
5. A bypass Claude session without `crossSessionInbound: accept`: the
   dialog appears there, and the tool's timeout text names both ways out
   (approve it there, or set the setting). The pipe has no receipt, so the
   tool cannot say "held" up front.
6. No token → 401; a wrong token → 401; 8 001 chars → 400.
7. Stopping or closing the Claude session: the tool says "no live Claude
   session" at once, from the registry.
8. `~/.forge/agent-bus` holds only `README.md`, `endpoint.json`, `forge.sh`
   and empty `inbox/` / `outbox/` after an exchange (CI row).
9. With `claude_transport: relay`, the same exchange works through `claude -p`.
10. `npm run ci` green; no file over 500 lines; OWNERS rows present.
