#!/usr/bin/env bash
#   forge.sh reply <id> [file]        answer a question Forge is waiting on
#   forge.sh say <your-name> [--model <name>] [--new] [--reply-in-chat] [--to <conversationId>|--to-running] [file]  message Forge
#   forge.sh send <your-name> <to> [--to <conversationId>|--to-running] [file]  relay, or target a Forge chat when <to> is forge
#   forge.sh send-file <your-name> --to <conversationId> <workspace-relative-path> [--caption-file <file>]  send a file directly to its Telegram chat (no Forge model turn)
#   forge.sh steer <your-name> <to> [file] interrupt <to>'s running turn (forge/claude/codex/copilot); runs next
#   forge.sh cancel <your-name> <id|all>  withdraw your queued message(s) to Forge not yet started
#   forge.sh join claude|codex        this interactive session becomes that mesh alias
#   forge.sh who                      who is in the mesh, and what each is doing
#   forge.sh status <your-name>       what your chat with Forge is doing now (tool, last words, context)
#   forge.sh view <your-name> [n]     the last n answers in your chat (default 3, max 10)
#   forge.sh wait <your-name> [minutes]  block until your chat is idle with nothing queued (default 60 min, exit 124 on timeout)
#   API Codex: join codex once, then use say codex --reply-in-chat and status/view
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
# Under WSL2 (NAT on Windows 10) 127.0.0.1 is the Linux VM, not Windows where
# Forge listens; Windows' curl.exe (via interop) reaches Windows' loopback.
# It cannot read /tmp, so @file bodies are translated with wslpath -w.
if [ -n "${WSL_DISTRO_NAME:-}" ] && command -v curl.exe >/dev/null 2>&1; then
  curl() {
    local a out=()
    for a in "$@"; do
      case "$a" in @/*) out+=("@$(wslpath -w "${a#@}")");; caption@/*) out+=("caption@$(wslpath -w "${a#caption@}")");; *) out+=("$a");; esac
    done
    curl.exe "${out[@]}"
  }
fi
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
if [ "$VERB" = "wait" ]; then
  # Block until the sender's chat is idle with nothing of theirs queued, then
  # print the final status and the latest answer so a supervising agent wakes
  # with the result. Polls /agent/status silently (no per-poll output); Ctrl-C
  # stops it. Exit 124 on timeout (last status to stderr), 1 on endpoint/auth
  # failure, 2 on bad arguments.
  NAME="${2:-}"; MINUTES="${3:-}"
  [ $# -le 3 ] || usage
  case "$NAME" in ""|*[!A-Za-z0-9._-]*) echo "forge.sh: a name is letters, digits, . _ - only" >&2; exit 2;; esac
  if [ -n "$MINUTES" ]; then
    case "$MINUTES" in *[!0-9]*) echo "forge.sh: minutes is a positive whole number" >&2; exit 2;; esac
    [ "$MINUTES" -ge 1 ] || { echo "forge.sh: minutes is a positive whole number" >&2; exit 2; }
  fi
  [ -f "$EP" ] || { echo "forge.sh: not reachable: open Forge with control_server and agent_bus enabled" >&2; exit 1; }
  URL="$(grep '"url"' "$EP" | cut -d'"' -f4)"
  TOKEN="$(grep '"token"' "$EP" | cut -d'"' -f4)"
  # ~55 s between polls: cheap for Forge, and a turn that ends between polls is
  # picked up on the next one. FORGE_WAIT_POLL_SECONDS is a test-only override
  # (a positive whole number of seconds) so integration tests do not sleep 55 s.
  POLL=55
  if [ -n "${FORGE_WAIT_POLL_SECONDS:-}" ]; then
    case "$FORGE_WAIT_POLL_SECONDS" in *[!0-9]*) echo "forge.sh: FORGE_WAIT_POLL_SECONDS is a positive whole number of seconds" >&2; exit 2;; esac
    [ "$FORGE_WAIT_POLL_SECONDS" -ge 1 ] || { echo "forge.sh: FORGE_WAIT_POLL_SECONDS is a positive whole number of seconds" >&2; exit 2; }
    POLL="$FORGE_WAIT_POLL_SECONDS"
  fi
  # Bounded: minutes up to 100000 keeps the deadline within 64-bit range.
  if [ "${MINUTES:-60}" -gt 100000 ]; then
    echo "forge.sh: minutes is 1-100000" >&2
    exit 2
  fi
  TIMEOUT_SECONDS=$((${MINUTES:-60} * 60))
  # Test-only: keep timeout coverage fast without replacing or evaluating a
  # command from the environment.
  if [ -n "${FORGE_WAIT_TIMEOUT_SECONDS:-}" ]; then
    case "$FORGE_WAIT_TIMEOUT_SECONDS" in *[!0-9]*) echo "forge.sh: FORGE_WAIT_TIMEOUT_SECONDS is a positive whole number of seconds" >&2; exit 2;; esac
    [ "$FORGE_WAIT_TIMEOUT_SECONDS" -ge 1 ] || { echo "forge.sh: FORGE_WAIT_TIMEOUT_SECONDS is a positive whole number of seconds" >&2; exit 2; }
    TIMEOUT_SECONDS="$FORGE_WAIT_TIMEOUT_SECONDS"
  fi
  START="$(date +%s)"
  LIMIT=$((START + TIMEOUT_SECONDS))
  LAST=""
  while :; do
    if LAST="$(curl -sS --fail-with-body -X GET -H "Authorization: Bearer $TOKEN" "$URL/agent/status?from=$NAME")"; then
      STATE="$(printf '%s\n' "$LAST" | sed -n 's/^State: //p' | head -n 1)"
      QUEUED="$(printf '%s\n' "$LAST" | sed -n 's/^Queued from you: //p' | head -n 1)"
      case "$STATE" in
        idle*)
          if [ "$QUEUED" = "0" ]; then
            printf '%s\n' "$LAST"
            curl -sS --fail-with-body -X GET -H "Authorization: Bearer $TOKEN" "$URL/agent/view?from=$NAME&count=1" \
              || { echo "forge.sh: Forge's endpoint did not accept it (see above)." >&2; exit 1; }
            exit 0
          fi;;
      esac
    else
      echo "forge.sh: Forge's endpoint did not accept it (see above)." >&2
      exit 1
    fi
    if [ "$(date +%s)" -ge "$LIMIT" ]; then
      echo "forge.sh: still not idle after ${MINUTES:-60} minute(s); last status:" >&2
      printf '%s\n' "$LAST" >&2
      exit 124
    fi
    sleep "$POLL"
  done
fi
if [ "$VERB" = "send-file" ]; then
  NAME="${2:-}"
  [ $# -ge 5 ] || usage
  case "$NAME" in ""|*[!A-Za-z0-9._-]*) echo "forge.sh: a name is letters, digits, . _ - only" >&2; exit 2;; esac
  shift 2
  [ "$1" = "--to" ] || usage
  CONVERSATION_ID="${2:-}"
  FILE_PATH="${3:-}"
  case "$CONVERSATION_ID" in ""|*[!A-Za-z0-9._-]*) echo "forge.sh: bad conversation id" >&2; exit 2;; esac
  [ -n "$FILE_PATH" ] || usage
  shift 3
  CAPTION_FILE=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --caption-file)
        [ $# -ge 2 ] && [ -z "$CAPTION_FILE" ] || usage
        CAPTION_FILE="$2"; shift 2;;
      *) usage;;
    esac
  done
  if [ -n "$CAPTION_FILE" ] && [ ! -f "$CAPTION_FILE" ]; then
    echo "forge.sh: caption file does not exist or is not a regular file" >&2
    exit 2
  fi
  [ -f "$EP" ] || { echo "forge.sh: not reachable: open Forge with control_server and agent_bus enabled" >&2; exit 1; }
  URL="$(grep '"url"' "$EP" | cut -d'"' -f4)"
  TOKEN="$(grep '"token"' "$EP" | cut -d'"' -f4)"
  SEND_ARGS=(
    -sS --fail-with-body -X POST
    -H "Authorization: Bearer $TOKEN"
    --data-urlencode "from=$NAME"
    --data-urlencode "conversation_id=$CONVERSATION_ID"
    --data-urlencode "path=$FILE_PATH"
  )
  if [ -n "$CAPTION_FILE" ]; then
    SEND_ARGS+=(--data-urlencode "caption@$CAPTION_FILE")
  fi
  curl "${SEND_ARGS[@]}" "$URL/agent/send-file" \
    || { echo "forge.sh: file send was not confirmed; no automatic retry was attempted." >&2; exit 1; }
  echo
  exit 0
fi
[ $# -ge 2 ] || usage
ARG=""; SRC="-"; MODEL=""; NEW_CHAT=""; REPLY_IN_CHAT=""; CONVERSATION_ID=""; TO_RUNNING=""
if [ "$VERB" = "say" ]; then
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --model) [ $# -ge 2 ] || usage; MODEL="$2"; shift 2;;
      --new) NEW_CHAT=true; shift;;
      --reply-in-chat) REPLY_IN_CHAT=true; shift;;
      --to) [ $# -ge 2 ] || usage; CONVERSATION_ID="$2"; shift 2;;
      --to-running) TO_RUNNING=true; shift;;
      --*) usage;;
      *) if [ -z "$ARG" ]; then ARG="$1"; elif [ "$SRC" = "-" ]; then SRC="$1"; else usage; fi; shift;;
    esac
  done
  [ -n "$ARG" ] || usage
elif [ "$VERB" = "send" ] || [ "$VERB" = "steer" ]; then
  ARG="$2"
  [ $# -ge 3 ] || usage
  TO="$3"; shift 3
  while [ $# -gt 0 ]; do
    case "$1" in
      --to) [ "$VERB" = "send" ] && [ "$TO" = "forge" ] && [ $# -ge 2 ] || usage; CONVERSATION_ID="$2"; shift 2;;
      --to-running) [ "$VERB" = "send" ] && [ "$TO" = "forge" ] || usage; TO_RUNNING=true; shift;;
      --*) usage;;
      *) [ "$SRC" = "-" ] || usage; SRC="$1"; shift;;
    esac
  done
  case "$TO" in ""|*[!A-Za-z0-9._-]*) echo "forge.sh: bad recipient '$TO'" >&2; exit 2;; esac
elif [ $# -ge 2 ]; then
  ARG="$2"
  [ $# -ge 3 ] && SRC="$3"
fi
case "$VERB" in
  reply) case "$ARG" in ""|*[!A-Za-z0-9_-]*) echo "forge.sh: bad id '$ARG'" >&2; exit 2;; esac
         ROUTE=reply; QUERY="id=$ARG" ;;
  say)   case "$ARG" in ""|*[!A-Za-z0-9._-]*) echo "forge.sh: a name is letters, digits, . _ - only" >&2; exit 2;; esac
         case "$CONVERSATION_ID" in ""|*[!A-Za-z0-9._-]*) [ -z "$CONVERSATION_ID" ] || { echo "forge.sh: bad conversation id '$CONVERSATION_ID'" >&2; exit 2; };; esac
         [ -z "$CONVERSATION_ID" ] || [ -z "$TO_RUNNING" ] || usage
         [ -z "$NEW_CHAT" ] || { [ -z "$CONVERSATION_ID" ] && [ -z "$TO_RUNNING" ]; } || usage
         ROUTE=message; QUERY="from=$ARG"; [ -n "$MODEL" ] && QUERY="$QUERY&model=$MODEL"; [ -n "$NEW_CHAT" ] && QUERY="$QUERY&new_chat=true"; [ -n "$REPLY_IN_CHAT" ] && QUERY="$QUERY&reply_in_chat=true"; [ -n "$CONVERSATION_ID" ] && QUERY="$QUERY&conversation_id=$CONVERSATION_ID"; [ -n "$TO_RUNNING" ] && QUERY="$QUERY&to_running=true" ;;
  send)  case "$ARG" in ""|*[!A-Za-z0-9._-]*) echo "forge.sh: a name is letters, digits, . _ - only" >&2; exit 2;; esac
         case "$CONVERSATION_ID" in ""|*[!A-Za-z0-9._-]*) [ -z "$CONVERSATION_ID" ] || { echo "forge.sh: bad conversation id '$CONVERSATION_ID'" >&2; exit 2; };; esac
         [ -z "$CONVERSATION_ID" ] || [ -z "$TO_RUNNING" ] || usage
         ROUTE=message; QUERY="from=$ARG&to=$TO"; [ -n "$CONVERSATION_ID" ] && QUERY="$QUERY&conversation_id=$CONVERSATION_ID"; [ -n "$TO_RUNNING" ] && QUERY="$QUERY&to_running=true" ;;
  steer) case "$ARG" in ""|*[!A-Za-z0-9._-]*) echo "forge.sh: a name is letters, digits, . _ - only" >&2; exit 2;; esac
         ROUTE=message; QUERY="from=$ARG&to=$TO&priority=steer" ;;
  cancel) case "$ARG" in ""|*[!A-Za-z0-9._-]*) echo "forge.sh: a name is letters, digits, . _ - only" >&2; exit 2;; esac
         [ $# -eq 3 ] || usage
         case "$3" in ""|*[!A-Za-z0-9_-]*) echo "forge.sh: bad id '$3' (the id say printed, or all)" >&2; exit 2;; esac
         ROUTE=cancel; QUERY="from=$ARG&id=$3"; SRC=/dev/null ;;
  join)  case "$ARG" in
           claude) case "$CLAUDE_PID" in ""|*[!0-9]*) echo "forge.sh: CLAUDE_PID is not set: run this from inside a Claude Code session" >&2; exit 2;; esac
                   QUERY="alias=$ARG&pid=$CLAUDE_PID" ;;
           codex) case "${CODEX_THREAD_ID:-}" in ""|*[!A-Za-z0-9._-]*) echo "forge.sh: CODEX_THREAD_ID is not set: run this from inside a Codex session" >&2; exit 2;; esac
                  QUERY="alias=$ARG&thread=$CODEX_THREAD_ID" ;;
           *) echo "forge.sh: join accepts only 'claude' or 'codex'" >&2; exit 2 ;;
         esac
         ROUTE=join; SRC=/dev/null ;;
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
