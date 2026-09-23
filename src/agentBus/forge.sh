#!/usr/bin/env bash
#   forge.sh reply <id> [file]        answer a question Forge is waiting on
#   forge.sh say <your-name> [--model <name>] [--new] [file]  send Forge a new message (starts a Forge turn)
#   forge.sh send <your-name> <to> [file]  relay a message to another agent (claude/codex)
#   forge.sh steer <your-name> <to> [file] interrupt <to>'s running turn (forge/claude/codex); runs next
#   forge.sh cancel <your-name> <id|all>  withdraw your queued message(s) to Forge not yet started
#   forge.sh join claude              this Claude Code session becomes the "claude" alias
#   forge.sh who                      who is in the mesh, and what each is doing
#   forge.sh status <your-name>       what your chat with Forge is doing now (tool, last words, context)
#   forge.sh view <your-name> [n]     the last n answers in your chat (default 3, max 10)
# The text comes from the file, or from stdin when no file is given.
# Written by Forge on every start; edits are overwritten.

# usage prints the leading comment block (lines after the shebang up to the
# first non-# line; the blank line above ends it) — derived, not a fixed range, so adding a verb line cannot
# silently cut off the last lines (the old fixed range dropped the text note
# when the who line landed).
usage() { awk 'NR==1{next} /^#/{print;next} {exit}' "$0" >&2; exit 2; }
VERB="${1:-}"; [ -n "$VERB" ] || usage
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
if [ "$VERB" = "status" ] || [ "$VERB" = "view" ]; then
  NAME="${2:-}"; COUNT="${3:-}"
  { [ "$VERB" = "status" ] && [ $# -eq 2 ]; } || { [ "$VERB" = "view" ] && [ $# -ge 2 ] && [ $# -le 3 ]; } || usage
  case "$NAME" in ""|*[!A-Za-z0-9._-]*) echo "forge.sh: a name is letters, digits, . _ - only" >&2; exit 2;; esac
  QUERY="from=$NAME"
  if [ -n "$COUNT" ]; then
    case "$COUNT" in *[!0-9]*) echo "forge.sh: n is a number (1-10)" >&2; exit 2;; esac
    QUERY="$QUERY&count=$COUNT"
  fi
  [ -f "$EP" ] || { echo "forge.sh: not reachable: open Forge with control_server and agent_bus enabled" >&2; exit 1; }
  URL="$(grep '"url"' "$EP" | cut -d'"' -f4)"
  TOKEN="$(grep '"token"' "$EP" | cut -d'"' -f4)"
  curl -sS --fail-with-body -X GET -H "Authorization: Bearer $TOKEN" "$URL/agent/$VERB?$QUERY" \
    || { echo "forge.sh: Forge's endpoint did not accept it (see above)." >&2; exit 1; }
  exit 0
fi
[ $# -ge 2 ] || usage
ARG=""; SRC="-"; MODEL=""; NEW_CHAT=""
if [ "$VERB" = "say" ]; then
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --model) [ $# -ge 2 ] || usage; MODEL="$2"; shift 2;;
      --new) NEW_CHAT=true; shift;;
      --*) usage;;
      *) if [ -z "$ARG" ]; then ARG="$1"; elif [ "$SRC" = "-" ]; then SRC="$1"; else usage; fi; shift;;
    esac
  done
  [ -n "$ARG" ] || usage
elif [ "$VERB" = "send" ] || [ "$VERB" = "steer" ]; then
  ARG="$2"
  [ $# -ge 3 ] || usage
  TO="$3"; [ $# -ge 4 ] && SRC="$4"
  case "$TO" in ""|*[!A-Za-z0-9._-]*) echo "forge.sh: bad recipient '$TO'" >&2; exit 2;; esac
elif [ $# -ge 2 ]; then
  ARG="$2"
  [ $# -ge 3 ] && SRC="$3"
fi
case "$VERB" in
  reply) case "$ARG" in ""|*[!A-Za-z0-9_-]*) echo "forge.sh: bad id '$ARG'" >&2; exit 2;; esac
         ROUTE=reply; QUERY="id=$ARG" ;;
  say)   case "$ARG" in ""|*[!A-Za-z0-9._-]*) echo "forge.sh: a name is letters, digits, . _ - only" >&2; exit 2;; esac
         ROUTE=message; QUERY="from=$ARG"; [ -n "$MODEL" ] && QUERY="$QUERY&model=$MODEL"; [ -n "$NEW_CHAT" ] && QUERY="$QUERY&new_chat=true" ;;
  send)  case "$ARG" in ""|*[!A-Za-z0-9._-]*) echo "forge.sh: a name is letters, digits, . _ - only" >&2; exit 2;; esac
         ROUTE=message; QUERY="from=$ARG&to=$TO" ;;
  steer) case "$ARG" in ""|*[!A-Za-z0-9._-]*) echo "forge.sh: a name is letters, digits, . _ - only" >&2; exit 2;; esac
         ROUTE=message; QUERY="from=$ARG&to=$TO&priority=steer" ;;
  cancel) case "$ARG" in ""|*[!A-Za-z0-9._-]*) echo "forge.sh: a name is letters, digits, . _ - only" >&2; exit 2;; esac
         [ $# -eq 3 ] || usage
         case "$3" in ""|*[!A-Za-z0-9_-]*) echo "forge.sh: bad id '$3' (the id say printed, or all)" >&2; exit 2;; esac
         ROUTE=cancel; QUERY="from=$ARG&id=$3"; SRC=/dev/null ;;
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
