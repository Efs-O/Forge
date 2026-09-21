/**
 * The text Forge writes into the agent-bus folder and the messages it sends
 * (docs/plans/AGENT_MESSAGING_PLAN.md). Kept in the extension, not hand-written
 * on one machine: a new user has no memory file and no FORGE.md line, so the
 * protocol has to arrive with the VSIX. `ensureBus()` rewrites both files
 * whenever they differ, so the copy on disk never drifts from the code.
 */

/** Longest text a single message into Forge may carry. */
export const MAX_INBOUND_CHARS = 8000;

/**
 * The client any agent with bash uses to reach Forge. Bash, because Claude
 * Code on Windows already requires Git Bash. It reads the endpoint written by
 * the running Forge; a reply falls back to the outbox file Forge polls, so an
 * answer still lands when the endpoint is off. String.raw: no escapes, and the
 * script avoids brace expansions so nothing here is interpolated.
 */
export const CLIENT_SCRIPT = String.raw`#!/usr/bin/env bash
#   forge.sh reply <id> [file]        answer a question Forge is waiting on
#   forge.sh say <your-name> [file]   send Forge a new message (starts a Forge turn)
#   forge.sh send <your-name> <to> [file]  relay a message to another agent (claude/codex)
#   forge.sh steer <your-name> <to> [file] interrupt <to>'s running turn (forge/claude/codex); runs next
#   forge.sh join claude              this Claude Code session becomes the "claude" alias
#   forge.sh who                      who is in the mesh, and what each is doing
# The text comes from the file, or from stdin when no file is given.
# Written by Forge on every start; edits are overwritten.

# usage prints the leading comment block (lines after the shebang up to the
# first non-# line; the blank line above ends it) — derived, not a fixed range, so adding a verb line cannot
# silently cut off the last lines (the old fixed range dropped the text note
# when the who line landed).
usage() { awk 'NR==1{next} /^#/{print;next} {exit}' "$0" >&2; exit 2; }
# VERB is $1 (not the default-value form): a dollar-brace sequence would be
# read as a template interpolation by the String.raw literal this script lives in.
VERB="$1"; [ -n "$VERB" ] || usage
ROOT="$(cd "$(dirname "$0")" && pwd)"
EP="$ROOT/endpoint.json"
# who is a GET with no body: it prints the mesh and exits before the body logic.
if [ "$VERB" = "who" ]; then
  [ $# -le 1 ] || usage
  [ -f "$EP" ] || { echo "forge.sh: not reachable: open Forge with control_server and agent_bus enabled" >&2; exit 1; }
  URL="$(grep '"url"' "$EP" | cut -d'"' -f4)"
  TOKEN="$(grep '"token"' "$EP" | cut -d'"' -f4)"
  BODY="$(curl -sS --fail-with-body -X GET -H "Authorization: Bearer $TOKEN" "$URL/agent/who")" || { echo "forge.sh: Forge's endpoint did not accept it." >&2; exit 1; }
  printf '%s\n' "$BODY" | sed 's/.*\[/[/;s/\].*//' | sed 's/},{/}\n{/g' | awk -F'"' '{
    a="";att="";act="";det=""
    for(i=1;i<=NF;i++){ if($i=="alias")a=$(i+2); else if($i=="attachment")att=$(i+2); else if($i=="activity")act=$(i+2); else if($i=="detail")det=$(i+2) }
    printf "%-8s  %-9s  %-9s  %s\n", a, att, act, det
  }'
  exit 0
fi
[ $# -ge 2 ] || usage
ARG="$2"; SRC="-"
if [ "$VERB" = "send" ] || [ "$VERB" = "steer" ]; then
  [ $# -ge 3 ] || usage
  TO="$3"; [ $# -ge 4 ] && SRC="$4"
  case "$TO" in ""|*[!A-Za-z0-9._-]*) echo "forge.sh: bad recipient '$TO'" >&2; exit 2;; esac
elif [ $# -ge 3 ]; then SRC="$3"; fi
case "$VERB" in
  reply) case "$ARG" in ""|*[!A-Za-z0-9_-]*) echo "forge.sh: bad id '$ARG'" >&2; exit 2;; esac
         ROUTE=reply; QUERY="id=$ARG" ;;
  say)   case "$ARG" in ""|*[!A-Za-z0-9._-]*) echo "forge.sh: a name is letters, digits, . _ - only" >&2; exit 2;; esac
         ROUTE=message; QUERY="from=$ARG" ;;
  send)  case "$ARG" in ""|*[!A-Za-z0-9._-]*) echo "forge.sh: a name is letters, digits, . _ - only" >&2; exit 2;; esac
         ROUTE=message; QUERY="from=$ARG&to=$TO" ;;
  steer) case "$ARG" in ""|*[!A-Za-z0-9._-]*) echo "forge.sh: a name is letters, digits, . _ - only" >&2; exit 2;; esac
         ROUTE=message; QUERY="from=$ARG&to=$TO&priority=steer" ;;
  join)  [ "$ARG" = "claude" ] || { echo "forge.sh: only 'join claude' exists" >&2; exit 2; }
         case "$CLAUDE_PID" in ""|*[!0-9]*) echo "forge.sh: CLAUDE_PID is not set: run this from inside a Claude Code session" >&2; exit 2;; esac
         ROUTE=join; QUERY="alias=$ARG&pid=$CLAUDE_PID"; SRC=/dev/null ;;
  *) usage ;;
esac
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
if [ "$SRC" = "-" ]; then cat > "$TMP"; else cp "$SRC" "$TMP" || exit 2; fi
if [ -f "$EP" ]; then
  URL="$(grep '"url"' "$EP" | cut -d'"' -f4)"
  TOKEN="$(grep '"token"' "$EP" | cut -d'"' -f4)"
  if curl -sS --fail-with-body -X POST -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: text/plain; charset=utf-8" --data-binary "@$TMP" "$URL/agent/$ROUTE?$QUERY"; then
    echo; exit 0
  fi
  echo "forge.sh: Forge's endpoint did not accept it (see above)." >&2
  WHY="Forge refused it"
else
  WHY="Forge is not reachable: open Forge with control_server and agent_bus enabled"
fi
if [ "$VERB" = "reply" ]; then
  # Forge polls this file while it waits, so the answer still lands.
  mkdir -p "$ROOT/outbox"
  cp "$TMP" "$ROOT/outbox/$ARG-reply.md.tmp" && mv "$ROOT/outbox/$ARG-reply.md.tmp" "$ROOT/outbox/$ARG-reply.md" \
    && echo "delivered via the outbox file" && exit 0
fi
echo "forge.sh: not delivered. $WHY." >&2
exit 1
`;

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
workspace, else starts its own (one-time consent). Relay to another agent with
\`forge.sh send <your-name> <to>\`.

## Who is in the mesh

\`bash ~/.forge/agent-bus/forge.sh who\` prints one line per participant —
\`forge\`, \`claude\`, \`codex\` and any other registered alias — with two
columns: **attachment** (how Forge reaches it: \`hub\`, \`joined\`, \`owned\`,
\`peer\`, \`none\`) and **activity** (\`busy\`, \`idle\`, \`parked\`, \`unknown\`,
\`dead\`). A session is \`unknown\` when Forge can write to it but cannot watch
its turns (a joined session, a pinned thread, or one another window owns) — it
never says \`idle\` for something it cannot see.

## Steering (interrupt a running turn)

\`forge.sh steer <your-name> <to>\` stops \`<to>\`'s running turn and runs your
text next — \`forge\` (Forge's own model), \`claude\` or \`codex\`. Use it to
correct an agent mid-turn instead of waiting for it to finish.

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
