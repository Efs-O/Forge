/**
 * The text Forge writes into the agent-bus folder and the messages it sends
 * (docs/plans/AGENT_MESSAGING_PLAN.md). Kept in the extension, not hand-written
 * on one machine: a new user has no memory file and no FORGE.md line, so the
 * protocol has to arrive with the VSIX. `ensureBus()` rewrites both files
 * whenever they differ, so the copy on disk never drifts from the code.
 */

import clientScriptSource from './forge.sh';

/** Longest text a single message into Forge may carry. */
export const MAX_INBOUND_CHARS = 8000;

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

Written by Forge; edits are overwritten. Lets Forge, Claude Code sessions and
Codex message each other, each message shown in the receiving window.

    endpoint.json   url + token of the running Forge (rotated on every start)
    forge.sh        the client: answer Forge, or send Forge a message
    inbox/          questions Forge is waiting on   <id>-forge.pending
    outbox/         file answers                    <id>-reply.md

## Doors

- **A Claude Code session**: its own peer pipe. Claude sessions use
  SendMessage; Forge's \`ask_live_session\` writes to the pipe directly. A
  session in bypass-permissions mode holds a Forge message for approval unless
  \`"crossSessionInbound": "accept"\` is set in ~/.claude/settings.json.
- **Codex**: \`codex queue --thread <id> --message <text>\`.
- **Forge**: \`forge.sh\`, or HTTP (below). An idle Forge starts a turn at
  once; a busy one queues the message until its turn ends.

## Joining (no renames, no config)

A Claude Code session that should take part runs \`bash ~/.forge/agent-bus/forge.sh join claude\`
once. Forge then reaches it as \`claude\` through its peer pipe while it stays
open. With no joined session, Forge uses the only Claude session open in the
workspace, else starts its own. Relay to another agent with
\`forge.sh send <your-name> <to>\`.

## Small follow-ups

Forge runs a local model: a one-line fix it does itself costs it the better
part of an hour. A reviewer that finds a small defect (about 20 changed lines
or fewer, in files already reviewed) applies it itself or hands it to
\`codex\`. Do not send it back to Forge.

## Who is in the mesh

\`bash ~/.forge/agent-bus/forge.sh who\` prints one line per participant —
\`forge\`, \`claude\`, \`codex\` and any other registered alias — with two
columns: **attachment** (how Forge reaches it: \`hub\`, \`joined\`, \`owned\`,
\`peer\`, \`none\`) and **activity** (\`busy\`, \`idle\`, \`parked\`, \`unknown\`,
\`dead\`). A session is \`unknown\` when Forge can write to it but cannot watch
its turns (a joined session, a pinned thread, or one another window owns) — it
never says \`idle\` for something it cannot see.

## Watching a running turn

\`bash ~/.forge/agent-bus/forge.sh status <your-name>\` shows what YOUR chat with Forge is doing:
busy or idle, how long the turn has run, seconds since its last activity, the tool it is on, how
many tool calls so far, the last thing it said, any warnings, and context use. \`view <your-name> [n]\`
replays the last n answers (default 3, max 10). Both read only the chat your own messages went to;
if you have not sent Forge anything yet there is nothing to show. Each is one small request and
costs Forge no model tokens, so use it instead of messaging Forge to ask how it is going.

## Steering (interrupt a running turn)

\`forge.sh steer <your-name> <to>\` stops \`<to>\`'s running turn and runs your
text next — \`forge\` (Forge's own model), \`claude\` or \`codex\`. Use it to
correct an agent mid-turn instead of waiting for it to finish.

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

## Messaging Forge first

    bash ~/.forge/agent-bus/forge.sh say claude-review <<'FORGE_MSG'
    your message
    FORGE_MSG

PowerShell:

    $ep = Get-Content "$HOME/.forge/agent-bus/endpoint.json" | ConvertFrom-Json
    Invoke-RestMethod -Method Post -Uri "$($ep.url)/agent/message?from=codex" \`
      -Headers @{ Authorization = "Bearer $($ep.token)" } \`
      -ContentType 'text/plain; charset=utf-8' -Body $text

An answer is \`POST /agent/reply?id=<id>\` with the same headers. JSON bodies
(\`{"from","text"}\`, \`{"id","text"}\`) work too. A message is at most
${MAX_INBOUND_CHARS} characters.

## Codex to Claude

Codex has no peer tool. It can relay through
\`claude -p --allowedTools SendMessage\`, which costs a model call (about
$0.10 each).

Never paste endpoint.json's token into a message. Files older than 24 hours
are swept.
`;

/** The bash path an agent runs, with forward slashes (bash and pwsh accept them). */
export function clientCommand(scriptPath: string): string {
  return `bash "${scriptPath.replace(/\\/g, '/')}"`;
}

/** What a Claude session receives for one `ask_live_session` question. */
export function claudeQuestion(
  scriptPath: string,
  id: string,
  subject: string,
  question: string,
): string {
  const cmd = clientCommand(scriptPath);
  return [
    `[Forge asks, question ${id}] ${subject}`,
    '',
    question,
    '',
    "Forge's agent is blocked until you answer. Show your user this question and your",
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
/** How to answer a sender: its alias as the target, or a named Claude session. */
function inboundHint(from: string): string {
  const alias = from.trim().toLowerCase();
  if (alias === 'claude' || alias === 'codex') return `\`target: "${alias}"\``;
  return `\`session: "${from}"\` (a Claude session)`;
}

export function forgeInboundPrompt(from: string, text: string): string {
  return (
    `**${from} says:**\n\n${text.trim()}\n\n` +
    `_(Agent-bus message. To answer, call \`ask_live_session\` with ${inboundHint(from)}.)_`
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
