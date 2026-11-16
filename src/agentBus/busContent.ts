/**
 * The text Forge writes into the agent-bus folder and the messages it sends
 * (docs/plans/AGENT_MESSAGING_PLAN.md). Kept in the extension, not hand-written
 * on one machine: a new user has no memory file and no FORGE.md line, so the
 * protocol has to arrive with the VSIX. `ensureBus()` rewrites both files
 * whenever they differ, so the copy on disk never drifts from the code.
 */

import clientScriptSource from './forge.sh';
import type { AskAgentOrigin } from '../agentLinks/liveSessionDelivery';
import type { AgentSenderMetadata } from '../agentLinks/chatAgentLinks';
import { agentDisplayName } from '../agentLinks/chatAgentLinks';
import { INBOX_CAP } from './agentInbox';

/** Longest text a single message into Forge may carry. */
export const MAX_INBOUND_CHARS = 16_000;

/**
 * The client any agent with bash uses to reach Forge. Bash, because Claude
 * Code on Windows already requires Git Bash. It reads the endpoint written by
 * the running Forge; a reply falls back to the outbox file Forge polls, so an
 * answer still lands when the endpoint is off.
 *
 * The script is a real file (./forge.sh), bundled as text. It used to be a
 * String.raw template here, where bash's `${1:-}` is a template interpolation:
 * that trap cost the local agent five failed type-check rounds
 * (docs/plans/MESH_RUN_1_FINDINGS.md, F1). CRs are stripped because a bash
 * script checked out with CRLF fails on `$'\r'`.
 */
export const CLIENT_SCRIPT = clientScriptSource.replace(/\r\n/g, '\n');

export const BUS_README = `# Forge agent bus

Written by Forge; edits are overwritten. Lets Forge, Claude Code, Codex and
Copilot sessions message each other, each message shown in the receiving window.

    endpoint.json   url + token of the focused Forge window, or of any open one when none has focus
    forge.sh        the client: answer Forge, or send Forge a message
    inbox/          questions Forge is waiting on   <id>-forge.pending
    outbox/         file answers                    <id>-reply.md
    remote-answers/ answers to remote-ask           <id>.md

## Doors

- **A Claude Code session**: its own peer pipe. Claude sessions use
  SendMessage; Forge's \`ask_agent\` writes to the pipe directly. A
  session in bypass-permissions mode holds a Forge message for approval unless
  \`"crossSessionInbound": "accept"\` is set in ~/.claude/settings.json.
- **Codex**: \`codex queue --thread <id> --message <text>\`.
- **Forge**: \`forge.sh\`, or HTTP (below). An idle Forge starts a turn at
  once. A \`say\` to a busy chat is read at its next tool round; its answer
  arrives when the turn ends; use \`steer\` only to stop the current work. A
  \`say\` with \`--model\` or \`--new\` needs a turn of its own, so it waits
  until the running turn ends.

When several Forge windows are open, every verb that knows your session
identity reaches the window holding that session's link — \`say\`, \`send\`,
\`steer\`, \`stop\`, \`wait\`, \`status\`, \`view\`, \`read-verdict\`,
\`ack-verdict\` and \`send-file\` all do; failing that, the window whose
workspace contains the sender's current folder; failing that, the last focused
Forge window (if that one closes, another open window takes over without being
focused). \`forge.sh who\` asks every window that answers and prints each
linked chat once, so a closed window is skipped instead of printing nothing.
It requests tab-delimited text so titles may contain brackets or quotes; an
older Forge window that only returns JSON is named on stderr and skipped.
\`forge.sh say <name> --new\` opens and selects a new chat there;
ordinary \`say\` follows that sender's previous chat without changing the view.
Use \`say <name> --to <conversationId>\` to select a specific Forge chat, or
\`say <name> --to-running\` to select the currently running chat. The same flags
work with \`send <name> forge\`; \`send\` to another agent remains a relay.
\`say\` flags:
- \`--model <name>\` selects the model for this turn. An unknown name is refused
  with the list of configured models, so read the 400 instead of guessing again.
- \`--new\` opens and links a second chat, keeping the sender's prior chat linked.
  The new chat runs in Clanker mode: Clanker answers routine approvals and still
  asks the owner before destructive actions, Forge guard files, skill writes, and
  a secret read followed by egress. \`--unattended\` was removed; the client
  refuses it.
- \`--to <conversationId>\` selects one linked Forge chat.
- \`--to-running\` selects the currently running Forge chat.
If a turn needs the owner's approval, it waits for the owner; \`stop\` or \`steer\`
cancels that approval card.
Use \`forge.sh stop <name> [--to <conversationId>]\` to cancel a running Forge
turn like the Stop button. Queued messages are not withdrawn and may start after
the turn stops; use \`forge.sh cancel\` for those.
Use \`forge.sh reload <name> --to <conversationId> [--force] [--reopen-claude <sessionId>]\` to reload the VS Code
window that holds that chat, so a newly installed VSIX takes effect. It can name
any open chat in the window, whether or not that chat is linked to your session.
If any chat in the window is running, reload refuses and names those chats; add
\`--force\` to reload anyway. After a reload the Claude Code extension restores only a session that was
mid-turn; an idle session's tab stays closed and no message can reach it.
\`--reopen-claude <sessionId>\` makes Forge reopen that session's tab in the
reloaded window. Reopening does not wake it: another Claude session (a
watcher in a different window) must then send it a message, for example with
SendMessage once \`ListAgents\` lists it again. The session id stays the same
across reloads; its peer name and [ref] change.
reload goes to the window that holds that chat, whichever window holds your own link.
Messages routed to an existing Forge chat print its id and title in the 202
response. There is no \`join\` command: an agent identifies itself from its
session environment variable.

## Sending a file to Telegram without a model turn

\`forge.sh send-file <your-name> --to <conversationId> <workspace-relative-path>
[--caption-file <file>]\` sends one existing workspace file directly through the
active Telegram transport. It does not enter Forge's inbox, start a model turn,
or change conversation context. The named conversation must be a Forge chat this
session is linked to — the same set \`--to\` may select for \`say\` — and have
exactly one Telegram binding in this workspace;
the client cannot choose a Telegram chat id. The path must resolve to a regular
file inside this workspace, between 1 byte and 50 MB. \`--caption-file <file>\`
supplies the Telegram caption text and is limited to 1,024 Unicode code points.

Telegram acceptance is reported as \`sent\`; a timeout or lost response is
\`unknown\`, not success. There is no automatic retry because a manual retry
after an ambiguous outcome may deliver a duplicate. Send only files the owner
explicitly requested: delivered copies remain on Telegram's servers, so never
send credentials, API keys, or config files.

## Full verdicts

When Forge asks for a verdict tied to an exchange, the full text is retained
under the agent-bus \`verdicts/\` directory. The sender of the original exchange
uses \`forge.sh read-verdict <name> <exchangeId>\` and then separately runs
\`forge.sh ack-verdict <name> <exchangeId>\`. Reading does not delete
the artifact; only the acknowledgment does. If a read response is lost, repeat
the read before acknowledging. Unacknowledged verdicts remain for recovery.

A \`--new\` needs a free chat tab. If that window is at its chat cap and nothing
can be archived, \`say --new\` exits non-zero with a 409 naming what is holding
every tab, and the message is **not** queued — send it again after a chat is
closed, or send it without \`--new\` to reach your existing chat.

## Linked agent sessions

Agent sessions identify themselves with their kind-specific session variable.
Forge routes messages to the chat linked to that session. Use
\`forge.sh send <your-name> <to>\` to ask another agent linked to the same chat.
\`send\` and \`steer\` cannot select a different Claude or Copilot session by
name or title; the \`--to\` and \`--to-running\` selectors apply only when
addressing Forge. Check \`who\` and the intended chat's agent link before a
relay. A 202 exchange id means accepted, not answered. Read its verdict or
failure before reporting success. Do not repeat a failed relay through the
same stale link. Forge's \`ask_agent\` reaches the agent linked to its current
chat; use the Claude session picker and \`/link\` to bind a specific live
Claude session to that chat. \`bash ~/.forge/agent-bus/forge.sh who\` lists the
linked sessions and the Forge window that holds each; \`/agents\` in Telegram
shows the current chat's links and their last-use times.

## Small follow-ups

Forge runs a local model: a one-line fix it does itself costs it the better
part of an hour. A reviewer that finds a small defect (about 20 changed lines
or fewer, in files already reviewed) applies it itself or hands it to
\`codex\`. Do not send it back to Forge.

## Watching a running turn

\`bash ~/.forge/agent-bus/forge.sh status <your-name> [--to <conversationId>]\` shows what YOUR chat with Forge is doing:
busy or idle, how long the turn has run, seconds since its last activity, the tool it is on, how
many tool calls so far, the last thing it said, any warnings, and context use. \`view <your-name> [n]
[--to <conversationId>]\` replays the last n answers (default 3, max 10). Both read only the chat
your own messages went to. With \`--to <conversationId>\` either verb reads a specific
chat instead: that chat has to be linked to your session, and one that is not
comes back a 404 naming it, so a read never lands on another session's chat.
Without \`--to\`, both keep following the chat this session last addressed.
Before your first message has started there is no chat to show: \`status\` then answers
\`State: queued\` with how many of your messages are waiting (a \`--new\` message opens its own
chat when it runs), while \`view\` still refuses until your first answer exists. Each is one
small request and
costs Forge no model tokens, so use it instead of messaging Forge to ask how it is going.

## Waiting for a turn to finish

\`forge.sh wait <your-name> [minutes] [--to <conversationId>]\` blocks until your chat with Forge is
idle with nothing of yours queued, then prints the final status and the latest
answer (the same text \`view <your-name> 1\` shows), so a supervising agent that
runs it in the background wakes with the result. It polls \`status\` internally
about every 55 seconds and prints nothing in between; the timeout is in
minutes (default 60) and a timed-out wait prints the last status to stderr and
exits 124. With \`--to\` it waits on that chat instead, as \`status --to\` reads
it; use it when your session drives more than one Forge chat. Ctrl-C stops it.
Use it instead of re-asking Forge how it is going.

## Steering (interrupt a running turn)

\`forge.sh steer <your-name> <to> [--to <conversationId>]\`: when \`<to>\` is
\`forge\`, it stops that chat's running turn and runs your text next, and \`--to\`
is accepted only then. When \`<to>\` is \`claude\`, \`codex\` or \`copilot\`, it
withdraws the request this chat already put to that agent and asks this
instead; Forge can stop only a session it started, never one the owner has open
in a terminal. Use it to correct work mid-turn instead of waiting for it to
finish.

## Withdrawing a queued message

\`forge.sh say\` prints \`{"queued":n,"id":"m…"}\`. If the message is no longer
needed before Forge starts it (you already said it another way, or the work
is done), withdraw it:

    bash ~/.forge/agent-bus/forge.sh cancel <your-name> <id>    # or: all

Only your own messages, and only ones that have not started; a running turn is
interrupted with \`steer\` instead. HTTP: \`POST /agent/cancel?from=<name>&id=<id>\`.

## Answering Forge

A Forge question ends with its id. Answer with

    bash ~/.forge/agent-bus/forge.sh reply <id> <<'FORGE_REPLY'
    your answer
    FORGE_REPLY

or write the answer to \`outbox/<id>-reply.md\` via a .tmp file and a rename.
Forge's agent is blocked until the answer lands, then shows it to its user.
Forge only reads an answer while it is still waiting: \`reply\` answers
\`{"delivered":true}\` then, and once the question has ended (answered, timed
out, or swept after 24 h) it answers \`{"accepted":true,"live":false}\` and
writes nothing, so send the answer again as a message with \`say\` or \`send\`.

## Reaching the chat that opened an exchange

A request that came from a remote chat carries the id of the exchange it
opened. \`forge.sh remote-notify claude <exchangeId>\` posts a note into that
chat; \`forge.sh remote-ask claude <exchangeId>\` posts a question, prints its
id, and waits up to 20 minutes for the user's \`/answer\` — the answer arrives
as \`remote-answers/<id>.md\`, and a timeout exits 124 with the question id, so
an answer that comes late is still in that file. The name is the agent kind
that opened the exchange — \`claude\`, \`codex\` or \`copilot\` — and the session
proves itself the way \`say\` does, from that kind's session environment
variable, so a session can only reach chats that opened its own active
exchanges. When the exchange has ended, its transport is off, or its chat is
no longer authorized, the request is refused with the reason (\`no active remote
session exchange for this sender\`, \`remote transport is not active\`, \`the
originating remote chat is no longer authorized\`) and nothing is queued, so an
unanswered note never waits silently. An exchange carries at most 20 outbound
messages.

## Messaging Forge first

    bash ~/.forge/agent-bus/forge.sh say claude <<'FORGE_MSG'
    your message
    FORGE_MSG

An agent session runs \`say claude\`, \`say codex\` or \`say copilot\` from its
own shell. Forge identifies it from that kind's session environment variable
and delivers the final answer to the session automatically. Use \`status\` and
\`view\` to inspect the linked Forge chat.

PowerShell on Windows (Git Bash, not a bare \`bash\` that may launch WSL):

    $text = 'your message'
    $text | & "$(git --exec-path)/../../../bin/bash.exe" "$HOME/.forge/agent-bus/forge.sh" say codex

\`git --exec-path\` resolves the bash that came with Git for Windows wherever it
is installed - \`C:\\Program Files\\Git\\bin\\bash.exe\` for an all-users
install, \`%LOCALAPPDATA%\\Programs\\Git\\bin\\bash.exe\` for a per-user one.
If \`Get-Command git.exe\` finds nothing, this client cannot run at all: the
machine needs Git for Windows (\`winget install --id Git.Git -e\`), and a bare
\`bash\` in PowerShell is usually WSL, whose home is not the Windows profile
Forge writes \`~/.forge\` into, so it will not find this folder either.

Use \`forge.sh reply <id>\` to answer a Forge question; the client handles
authentication and has an outbox fallback. A message is at most
${MAX_INBOUND_CHARS} characters. Forge holds at most ${INBOX_CAP} unread agent messages
at once; the next \`say\` is refused with \`429 Forge has too many unread agent
messages\`, so \`wait\` or \`view\` for one of your turns to finish before sending
another.

A \`say\` that starts a turn in an attended chat can stop on a tool-approval
card. The owner answers it in the sidebar or the chat's bound Telegram.
Nobody answers it, the card keeps waiting until
\`permissions.approval_timeout_minutes\` expires it — a new install ships 10
minutes, an older config has no key and waits forever, so \`wait\` exits 124
with the chat still busy. Read \`status\` before concluding anything.

## Claude to Codex or Copilot

Use \`forge.sh send claude codex\` or \`forge.sh send claude copilot\`. If the
chat already has a link for that agent, Forge asks that session; if it has
none, Forge starts its own and links it to the chat - its title is
\`Forge · <chat>\` and \`who\` lists it afterwards. Forge, not the caller,
chooses the session: the chat's existing link, or a new one it starts, and you
cannot pick which instance answers by retrying with another id. An exchange id
confirms acceptance, not an answer; read the verdict or the failure before
reporting success. \`send claude forge\` starts a Forge model turn instead.

## Codex to Claude

Use \`forge.sh send codex claude\`. The same rule as above: the Claude session
linked to Codex's current Forge chat answers if there is one, and Forge starts
one if there is none. If the owner names a different running Claude session,
identify its exact session id first; Forge's Claude peer connection and
question/reply protocol can reach it without starting a new CLI process. Do not
guess from a chat title or retry the chat-linked relay after it reaches the
wrong session. Copilot has no separate peer-pipe path here.

Never paste endpoint.json's token into a message. Files older than 24 hours
are swept.
`;

/** The bash path an agent runs, with forward slashes (bash and pwsh accept them). */
function clientCommand(scriptPath: string): string {
  return `bash "${scriptPath.replace(/\\/g, '/')}"`;
}

/** What a Claude session receives for one `ask_agent` question. */
export function claudeQuestion(
  scriptPath: string,
  id: string,
  subject: string,
  question: string,
  origin?: AskAgentOrigin,
): string {
  const cmd = clientCommand(scriptPath);
  return [
    origin?.kind === 'owner'
      ? `[Owner message via Telegram, question ${id}] ${subject}`
      : `[Forge asks, question ${id}] ${subject}`,
    '',
    question,
    '',
    origin?.kind === 'owner'
      ? 'The owner is waiting on Telegram for your answer. Show your user this message and your'
      : "Forge's agent is blocked until you answer. Show your user this question and your",
    'answer, then send the answer with:',
    '',
    `${cmd} reply ${id} <<'FORGE_REPLY'`,
    '<your answer>',
    'FORGE_REPLY',
    '',
    `(Or write it to a file and run: ${cmd} reply ${id} <file>.) Not SendMessage: Forge`,
    'is not a Claude session.',
  ].join('\n');
}

/** The prompt an inbound message becomes in Forge's chat. */
/** Sender attribution and automatic-reply footer for a linked session. */
export function forgeInboundPrompt(
  from: string,
  text: string,
  sender?: AgentSenderMetadata,
): string {
  if (!sender) return `**${from} says:**\n\n${text.trim()}`;
  const label = agentDisplayName(sender.kind);
  const title = sender.title.replaceAll('"', '\\"');
  return (
    `**${label} says:**\n\n${text.trim()}\n\n` +
    `From ${label} session "${title}". Your final answer is delivered to it automatically.`
  );
}

/**
 * The inverse of `forgeInboundPrompt`: who sent a bus-delivered prompt and what
 * they said, or undefined for a prompt the user typed. Remote views label a bus
 * prompt by its sender. Labelling it "You:" made an agent's words read as the
 * user's own.
 */
export function parseForgeInboundPrompt(
  prompt: string,
): { from: string; text: string } | undefined {
  const match = /^\*\*([A-Za-z0-9._ -]{1,40}) says:\*\*\s*/u.exec(prompt);
  if (!match) return undefined;
  const body = prompt.slice(match[0].length).replace(/\s*_\(Agent-bus message\.[\s\S]*$/u, '');
  return { from: match[1] as string, text: body.trim() };
}
