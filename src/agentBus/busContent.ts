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
# The text comes from the file, or from stdin when no file is given.
# Written by Forge on every start; edits are overwritten.
usage() { sed -n '2,4p' "$0" >&2; exit 2; }
[ $# -ge 2 ] || usage
VERB="$1"; ARG="$2"; SRC="-"
[ $# -ge 3 ] && SRC="$3"
case "$VERB" in
  reply) case "$ARG" in ""|*[!A-Za-z0-9_-]*) echo "forge.sh: bad id '$ARG'" >&2; exit 2;; esac
         ROUTE=reply; QUERY="id=$ARG" ;;
  say)   case "$ARG" in ""|*[!A-Za-z0-9._-]*) echo "forge.sh: a name is letters, digits, . _ - only" >&2; exit 2;; esac
         ROUTE=message; QUERY="from=$ARG" ;;
  *) usage ;;
esac
ROOT="$(cd "$(dirname "$0")" && pwd)"
EP="$ROOT/endpoint.json"
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
export function forgeInboundPrompt(from: string, text: string): string {
  return (
    `**${from} says:**\n\n${text.trim()}\n\n` +
    '_(Agent-bus message. To answer, call `ask_live_session`: ' +
    `\`session: "${from}"\` for a Claude session, \`target: "codex"\` for Codex.)_`
  );
}
