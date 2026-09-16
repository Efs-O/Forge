/**
 * The text Forge writes into the agent-bus folder, and the prompt a user pastes
 * into Claude Code to start listening. Kept in the extension, not hand-written
 * on one machine: a new user has no memory file and no FORGE.md line, so the
 * protocol has to arrive with the VSIX (AGENT_BUS_TOOL_PLAN.md, "Distribution").
 * `ensureBus()` rewrites both files whenever they differ, so the copy on disk
 * never drifts from the code that reads the bus.
 */

/** How often the watcher sweeps the inbox and touches the heartbeat. */
export const WATCH_INTERVAL_SECONDS = 5;

/**
 * Bash, because the listener is a Claude Code session and Claude Code on
 * Windows already requires Git Bash. The folder comes from the script's own
 * location, not `$HOME`, so a HOME that differs from the OS profile cannot
 * point it at a different bus.
 */
export const WATCH_SCRIPT = `#!/usr/bin/env bash
# Forge agent-bus watcher (written by Forge; edits are overwritten).
# A live Claude Code session runs this as a background Monitor with the maximum
# timeout and re-arms it on expiry. One stdout line per new inbox message.
ROOT="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$ROOT/inbox" "$ROOT/outbox"
while true; do
  touch "$ROOT/listening"
  for f in "$ROOT"/inbox/*.md; do
    [ -e "$f" ] || continue
    [ -e "$f.notified" ] && continue
    touch "$f.notified"
    echo "INBOX $(basename "$f") :: $(head -c 500 "$f" | tr '\\n' ' ')"
  done
  sleep ${WATCH_INTERVAL_SECONDS}
done
`;

/** The prompt that turns any open Claude Code session into a listener. */
export function armPrompt(busRoot: string): string {
  const root = busRoot.replace(/\\/g, '/');
  return [
    'Watch the Forge agent bus for the rest of this session.',
    `Run \`bash "${root}/watch.sh"\` as a background Monitor with the maximum`,
    'timeout, and re-arm it whenever it expires. Each INBOX line is a question',
    'from another agent: read that file, answer it, and write your answer to',
    `\`${root}/outbox/<same id>-reply.md\`: write a .tmp file first, then rename it.`,
    'In your visible reply to me, show both sides verbatim:',
    '**Forge asks:** ... and **I replied:** ...',
    `Full protocol: \`${root}/README.md\`.`,
  ].join('\n');
}

export const BUS_README = `# Forge agent bus

Written by Forge; edits are overwritten. A file mailbox that lets an agent ask
a Claude Code session that is **already running**, keeping that session's
context. Forge's own agent uses the \`ask_live_session\` tool; anything else with
a shell (Codex, scripts) follows the protocol below.

    inbox/     questions   <id>-<who>.md
    outbox/    answers     <id>-reply.md
    listening  heartbeat, touched every ${WATCH_INTERVAL_SECONDS} s by the watcher
    watch.sh   the watcher a listening session runs

## Listening (a Claude Code session)

Only an interactive session can listen. A \`claude -p\` run exits when its turn
ends, and its watcher stops with it. Paste the prompt from the Forge command
"Copy Claude Bus Prompt" into an open session, or run \`watch.sh\` under a
background Monitor yourself, with the maximum timeout, re-armed on expiry.

For each INBOX line: read the file, answer it, and write the answer to
\`outbox/<id>-reply.md\` **via a .tmp file and a rename**, so the asker never
reads half a file. Show the user both sides verbatim (**Forge asks:** /
**I replied:**). A Monitor event is not shown as a chat message, so this is the
only way the user sees the exchange.

## Asking (bash)

    BUS="$HOME/.forge/agent-bus"
    [ -n "$(find "$BUS/listening" -mmin -3 2>/dev/null)" ] || { echo "nobody listening"; exit 1; }
    ID="sh$(date +%s%N)-$RANDOM"
    printf 'Subject: <one line>\\n\\n<question>\\n' > "$BUS/inbox/$ID-ask.md.tmp"
    mv "$BUS/inbox/$ID-ask.md.tmp" "$BUS/inbox/$ID-ask.md"
    for i in $(seq 1200); do [ -f "$BUS/outbox/$ID-reply.md" ] && break; sleep 1; done
    cat "$BUS/outbox/$ID-reply.md"
    rm -f "$BUS/inbox/$ID-ask.md" "$BUS/inbox/$ID-ask.md.notified" "$BUS/outbox/$ID-reply.md"

Rules: one question per file; the first line is \`Subject: ...\` and is all the
listener sees first; ids are never reused; delete your files after reading the
reply. A heartbeat older than 3 minutes means nobody is listening, so do not
wait. Files older than 24 hours are swept. Nothing here is secret: never put
tokens or keys in a message.
`;
