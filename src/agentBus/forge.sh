#!/usr/bin/env bash
#   forge.sh reply <id> [file]        answer a question Forge is waiting on
#   forge.sh say <your-name> [--model <name>] [--new] [--to <conversationId>|--to-running] [file]  message Forge (the chat this session last addressed; --to any chat this session is linked to, or an open chat that holds none; --new starts and links a second chat, the first keeps its link; --to-running selects the chat running a turn now; set at most one of --to, --to-running and --new, or the bus refuses the message)
#   forge.sh send <your-name> <to> [--to <conversationId>|--to-running] [file]  relay (the verdict wakes the sending Forge chat when it is open), or target a Forge chat when <to> is forge
#   forge.sh send-file <your-name> --to <conversationId> <workspace-relative-path> [--caption-file <file>]  send a file directly to its Telegram chat (no Forge model turn); --to is required, --caption-file holds the caption (1,024 code points)
#   forge.sh remote-notify <claude|codex|copilot> <exchangeId> [file]  notify the Telegram chat that opened this exchange
#   forge.sh remote-ask <claude|codex|copilot> <exchangeId> [file]  ask that chat and wait up to 20 minutes for /answer
#   forge.sh notify <your-name> [file]  send the owner a Telegram message through Forge's notify outbox (no chat, no model turn); one pending per name, a newer one replaces it
#   forge.sh read-verdict <your-name> <exchangeId>  read the full retained verdict without consuming it
#   forge.sh ack-verdict <your-name> <exchangeId>   acknowledge a read verdict and remove its retained copy
#   An answer kept for you that you did not see live is announced on every call: one line on stderr naming its chat and exchange, until you acknowledge it or 24 hours pass.
#   forge.sh steer <your-name> <to> [--to <conversationId>] [file] forge: interrupt the running turn and run this next (--to only here); claude/codex/copilot: withdraw this chat's earlier ask to that agent and ask this instead
#   forge.sh stop <your-name> [--to <conversationId>]  cancel a running Forge turn; queued messages may still start
#   forge.sh reload <your-name> --to <conversationId> [--force] [--reopen-claude <sessionId>]  reload the window holding that chat; --force allows a running turn to be cut off; --reopen-claude reopens an idle Claude Code session
#   forge.sh cancel <your-name> <id|all>  withdraw your queued message(s) to Forge not yet started
#   forge.sh who                      every live Forge window's linked agent sessions, one row per linked chat (titles may contain brackets or quotes)
#   forge.sh status <your-name> [--to <conversationId>]  what your chat with Forge is doing now (tool, last words, context); --to reads a chat linked to your session, and a chat that is not linked is refused by name; before your first turn starts, your queue
#   forge.sh view <your-name> [n] [--to <conversationId>]  the last n answers in your chat (default 3, max 10); --to reads a chat linked to your session
#   forge.sh wait <your-name> [minutes] [--to <conversationId>]  block until your chat is idle with nothing queued (default 60 min, exit 124 on timeout); --to waits on that chat, which must be linked to your session
#   Agent sessions identify themselves from their kind-specific session environment variable.
#   Every verb that knows your session identity follows that session's link to the Forge window holding it, so a second window being focused does not send your read somewhere else; who reads every live window.
#   A chat you start with --new runs in Clanker mode: Clanker answers routine approvals and still asks the owner before destructive actions, Forge guard files, skill writes, and a secret read followed by egress.
#   A say to a busy chat is read at its next tool round; its answer arrives when the turn ends; use steer only to stop the current work.
#   A say with --model or --new needs its own turn, so it waits until the running turn ends.
#   A say with --new opens that chat and names it before its first message runs, and the answer carries its conversation id: keep it, because a later --to needs it, and a refusal that names a chat id means that chat is already open and empty.
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
SENDER_QUERY=""; SENDER_KIND=""; SENDER_ID=""
set_sender_identity() {
  case "$1" in
    claude) SENDER_KIND=claude; SENDER_VAR=CLAUDE_CODE_SESSION_ID; SENDER_ID="${CLAUDE_CODE_SESSION_ID:-}";;
    codex) SENDER_KIND=codex; SENDER_VAR=CODEX_SESSION_ID; SENDER_ID="${CODEX_SESSION_ID:-}";;
    copilot) SENDER_KIND=copilot; SENDER_VAR=COPILOT_AGENT_SESSION_ID; SENDER_ID="${COPILOT_AGENT_SESSION_ID:-}";;
    *) return;;
  esac
  [ -n "$SENDER_ID" ] || { echo "forge.sh: $SENDER_VAR is not set; refusing to send as $SENDER_KIND" >&2; exit 2; }
  case "$SENDER_KIND:$SENDER_ID" in
    claude:*|codex:*) echo "$SENDER_ID" | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' || { echo "forge.sh: invalid $SENDER_VAR session id" >&2; exit 2; };;
    copilot:*) case "$SENDER_ID" in *[!A-Za-z0-9._:-]*|'') echo "forge.sh: invalid $SENDER_VAR session id" >&2; exit 2;; esac;;
  esac
  SENDER_QUERY="&sender=%7B%22kind%22%3A%22$SENDER_KIND%22%2C%22sessionId%22%3A%22$SENDER_ID%22%7D"
}
set_optional_sender_identity() {
  case "$1" in
    claude) [ -n "${CLAUDE_CODE_SESSION_ID:-}" ] && set_sender_identity "$1";;
    codex) [ -n "${CODEX_SESSION_ID:-}" ] && set_sender_identity "$1";;
    copilot) [ -n "${COPILOT_AGENT_SESSION_ID:-}" ] && set_sender_identity "$1";;
  esac
}
# Pick the window this request should go to, and set EP. The window holding this
# session's link wins; else the one whose workspace holds the current folder
# (longest root), so a new chat opens in the sender's repo; else endpoint.json,
# the last focused window. A window that does not answer within 1s is skipped.
# Every verb that knows the sender's identity calls this — reads included — so a
# read never lands on a window that never held the session.
resolve_endpoint() {
  [ -n "$SENDER_KIND" ] || return 0
  local HOLDER="" NEAREST="" NEAREST_LEN=0 SENDER_CWD="$PWD" WINDOW_EP WINDOW_URL WINDOW_TOKEN HELD MATCH
  if command -v cygpath >/dev/null 2>&1; then SENDER_CWD="$(cygpath -w "$PWD")"
  elif [ -n "${WSL_DISTRO_NAME:-}" ] && command -v wslpath >/dev/null 2>&1; then SENDER_CWD="$(wslpath -w "$PWD" 2>/dev/null || printf '%s' "$PWD")"; fi
  for WINDOW_EP in "$ROOT"/endpoints/*.json; do
    [ -f "$WINDOW_EP" ] || continue
    WINDOW_URL="$(grep '"url"' "$WINDOW_EP" | cut -d'"' -f4)"
    WINDOW_TOKEN="$(grep '"token"' "$WINDOW_EP" | cut -d'"' -f4)"
    [ -n "$WINDOW_URL" ] && [ -n "$WINDOW_TOKEN" ] || continue
    HELD="$(curl -sS --connect-timeout 1 --max-time 3 -G -H "Authorization: Bearer $WINDOW_TOKEN" --data-urlencode "kind=$SENDER_KIND" --data-urlencode "sessionId=$SENDER_ID" --data-urlencode "cwd=$SENDER_CWD" "$WINDOW_URL/agent/holds-link" 2>/dev/null)" || continue
    case "$HELD" in *'"holdsLink":true'*)
      [ -z "$HOLDER" ] || { echo "forge.sh: more than one live Forge window claims this session" >&2; exit 1; }
      HOLDER="$WINDOW_EP";;
    esac
    MATCH="$(printf '%s' "$HELD" | sed -n 's/.*"cwdMatch":\([0-9][0-9]*\).*/\1/p')"
    if [ -n "$MATCH" ] && [ "$MATCH" -gt "$NEAREST_LEN" ]; then NEAREST="$WINDOW_EP"; NEAREST_LEN="$MATCH"; fi
  done
  if [ -n "$HOLDER" ]; then EP="$HOLDER"; elif [ -n "$NEAREST" ]; then EP="$NEAREST"; fi
}
# Reload is addressed to a chat rather than the sender's linked chat. The chat
# may be held by a different Forge window, so ask every live endpoint directly.
resolve_reload_endpoint() {
  local HOLDER="" SENDER_CWD="$PWD" WINDOW_EP WINDOW_URL WINDOW_TOKEN HELD
  if command -v cygpath >/dev/null 2>&1; then SENDER_CWD="$(cygpath -w "$PWD")"
  elif [ -n "${WSL_DISTRO_NAME:-}" ] && command -v wslpath >/dev/null 2>&1; then SENDER_CWD="$(wslpath -w "$PWD" 2>/dev/null || printf '%s' "$PWD")"; fi
  for WINDOW_EP in "$ROOT"/endpoints/*.json; do
    [ -f "$WINDOW_EP" ] || continue
    WINDOW_URL="$(grep '"url"' "$WINDOW_EP" | cut -d'"' -f4)"
    WINDOW_TOKEN="$(grep '"token"' "$WINDOW_EP" | cut -d'"' -f4)"
    [ -n "$WINDOW_URL" ] && [ -n "$WINDOW_TOKEN" ] || continue
    HELD="$(curl -sS --connect-timeout 1 --max-time 3 -G -H "Authorization: Bearer $WINDOW_TOKEN" --data-urlencode "kind=$SENDER_KIND" --data-urlencode "sessionId=$SENDER_ID" --data-urlencode "cwd=$SENDER_CWD" --data-urlencode "conversation_id=$CONVERSATION_ID" "$WINDOW_URL/agent/holds-link" 2>/dev/null)" || continue
    case "$HELD" in *'"holdsChat":true'*)
      [ -z "$HOLDER" ] || { echo "forge.sh: more than one live Forge window holds chat \"$CONVERSATION_ID\"." >&2; exit 1; }
      HOLDER="$WINDOW_EP";;
    esac
  done
  if [ -n "$HOLDER" ]; then
    EP="$HOLDER"
  else
    echo "forge.sh: no open Forge window holds chat \"$CONVERSATION_ID\"." >&2
    exit 1
  fi
}
# The routes append one line per answer this session has not seen live:
#   WAITING_VERDICT<TAB><exchangeId><TAB><chat title>
# Print those on stderr as a sentence the agent can act on, and print everything
# else on stdout unchanged — a session parsing say's JSON still sees just the
# JSON. The title is whatever follows the second tab, so a title containing tabs,
# quotes or spaces passes through exactly as Forge wrote it.
report_waiting_verdicts() {
  local name="$1"
  awk -v name="$name" '
    BEGIN { FS = "\t" }
    $1 == "WAITING_VERDICT" && NF >= 3 {
      id = $2
      title = substr($0, length($1) + length($2) + 3)
      printf "forge.sh: an answer is waiting for you from chat \"%s\" (exchange %s), not seen live. Read it with: forge.sh read-verdict %s %s\n", title, id, name, id > "/dev/stderr"
      next
    }
    { print }'
}
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
# who is a GET with no body: it prints linked sessions and exits before the body logic.
if [ "$VERB" = "who" ]; then
  [ $# -le 1 ] || usage
  # Ask every window, not the focused one: endpoint.json is a single window's
  # url, so `who` used to list one window's sessions while other windows held
  # sessions of their own. A window that does not answer within 1s is skipped
  # (the holder search skips it the same way). A row is printed once — keyed on
  # the whole printed line, not on the session column, because one agent session
  # can hold several Forge chats (977ffbed) and each linked chat is its own row
  # with a different chat title; keying on the session column would hide every
  # chat after the first. Only the same window answering twice repeats a line,
  # which two endpoint files naming one live window can do. Nothing answering
  # is a failure with a reason, never an empty success.
  WHO_TMP="$(mktemp)"; trap 'rm -f "$WHO_TMP"' EXIT
  : > "$WHO_TMP"
  WHO_REACHED=0
  WHO_ENDPOINTS=("$ROOT"/endpoints/*.json)
  [ -f "${WHO_ENDPOINTS[0]}" ] || WHO_ENDPOINTS=("$EP")
  for WHO_EP in "${WHO_ENDPOINTS[@]}"; do
    [ -f "$WHO_EP" ] || continue
    URL="$(grep '"url"' "$WHO_EP" | cut -d'"' -f4)"
    TOKEN="$(grep '"token"' "$WHO_EP" | cut -d'"' -f4)"
    WINDOW_ID="$(grep '"windowId"' "$WHO_EP" | cut -d'"' -f4)"
    [ -n "$URL" ] && [ -n "$TOKEN" ] || continue
    BODY="$(curl -sS --connect-timeout 1 --max-time 3 --fail-with-body -X GET -H "Authorization: Bearer $TOKEN" "$URL/agent/who?format=text" 2>/dev/null)" || continue
    WHO_REACHED=1
    case "$BODY" in
      \{*) echo "forge.sh: window $WINDOW_ID runs an older Forge; update it to list its sessions" >&2; continue ;;
    esac
    printf '%s\n' "$BODY" >> "$WHO_TMP"
  done
  [ "$WHO_REACHED" = 1 ] || { echo "forge.sh: not reachable: open Forge with control_server and agent_bus enabled" >&2; exit 1; }
  awk -F'\t' 'NF >= 3 {
    row=sprintf("%-8s  %-9s  %-9s  %s", $1, $2, $3, $4)
    if (!seen[row]++) print row
  }' "$WHO_TMP"
  exit 0
fi
if [ "$VERB" = "notify" ]; then
  [ $# -ge 2 ] && [ $# -le 3 ] || usage
  NAME="$2"; SRC="${3:--}"
  case "$NAME" in ""|*[!A-Za-z0-9._-]*) echo "forge.sh: a name is letters, digits, . _ - only" >&2; exit 2;; esac
  set_optional_sender_identity "$NAME"
  TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
  if [ "$SRC" = "-" ]; then cat > "$TMP"; else cp "$SRC" "$TMP" || exit 2; fi
  resolve_endpoint
  [ -f "$EP" ] || { echo "forge.sh: not reachable: open Forge with control_server and agent_bus enabled" >&2; exit 1; }
  URL="$(grep '"url"' "$EP" | cut -d'"' -f4)"
  TOKEN="$(grep '"token"' "$EP" | cut -d'"' -f4)"
  curl -sS --fail-with-body -X POST -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: text/plain; charset=utf-8" --data-binary "@$TMP" \
    "$URL/agent/notify?from=$NAME$SENDER_QUERY" \
    || { echo; echo "forge.sh: Forge's endpoint did not accept it (see above)." >&2; exit 1; }
  echo; exit 0
fi
if [ "$VERB" = "remote-notify" ] || [ "$VERB" = "remote-ask" ]; then
  [ $# -ge 3 ] && [ $# -le 4 ] || usage
  NAME="$2"; EXCHANGE_ID="$3"; SRC="${4:--}"
  case "$NAME" in claude|codex|copilot) ;; *) echo "forge.sh: expected claude, codex or copilot" >&2; exit 2;; esac
  set_sender_identity "$NAME"
  case "$EXCHANGE_ID" in ""|*[!a-f0-9-]*) echo "forge.sh: invalid exchange id" >&2; exit 2;; esac
  TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
  if [ "$SRC" = "-" ]; then cat > "$TMP"; else cp "$SRC" "$TMP" || exit 2; fi
  resolve_endpoint
  [ -f "$EP" ] || { echo "forge.sh: Forge is not reachable" >&2; exit 1; }
  URL="$(grep '"url"' "$EP" | cut -d'"' -f4)"
  TOKEN="$(grep '"token"' "$EP" | cut -d'"' -f4)"
  if [ "$VERB" = "remote-ask" ]; then ROUTE=remote-ask; else ROUTE=remote-notify; fi
  RESULT="$(curl -sS --fail-with-body -X POST -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: text/plain; charset=utf-8" --data-binary "@$TMP" \
    "$URL/agent/$ROUTE?from=$NAME&exchange_id=$EXCHANGE_ID$SENDER_QUERY")" \
    || { echo "forge.sh: remote delivery was not confirmed; do not retry blindly" >&2; exit 1; }
  if [ "$VERB" = "remote-notify" ]; then printf '%s\n' "$RESULT"; exit 0; fi
  QUESTION_ID="$RESULT"
  case "$QUESTION_ID" in ""|*[!a-f0-9-]*) echo "forge.sh: invalid question id from Forge" >&2; exit 1;; esac
  ATTEMPT=0
  while [ "$ATTEMPT" -lt 1200 ]; do
    if [ -f "$ROOT/remote-answers/$QUESTION_ID.md" ]; then
      cat "$ROOT/remote-answers/$QUESTION_ID.md"
      exit 0
    fi
    sleep 1
    ATTEMPT=$((ATTEMPT + 1))
  done
  echo "forge.sh: no Telegram answer within 20 minutes (question $QUESTION_ID)" >&2
  exit 124
fi
if [ "$VERB" = "status" ] || [ "$VERB" = "view" ]; then
  NAME="${2:-}"; COUNT=""; READ_CONVERSATION_ID=""
  [ $# -ge 2 ] || usage
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --to) [ $# -ge 2 ] && [ -z "$READ_CONVERSATION_ID" ] || usage; READ_CONVERSATION_ID="$2"; shift 2;;
      --*) usage;;
      *) [ "$VERB" = "view" ] && [ -z "$COUNT" ] || usage; COUNT="$1"; shift;;
    esac
  done
  # Only `view` takes a count, and it takes it once, wherever `--to` sits.
  [ "$VERB" != "status" ] || [ -z "$COUNT" ] || usage
  case "$NAME" in ""|*[!A-Za-z0-9._-]*) echo "forge.sh: a name is letters, digits, . _ - only" >&2; exit 2;; esac
  case "$READ_CONVERSATION_ID" in ""|*[!A-Za-z0-9._-]*) [ -z "$READ_CONVERSATION_ID" ] || { echo "forge.sh: bad conversation id '$READ_CONVERSATION_ID'" >&2; exit 2; };; esac
  set_optional_sender_identity "$NAME"
  QUERY="from=$NAME"
  [ -n "$SENDER_KIND" ] && QUERY="$QUERY&kind=$SENDER_KIND&sessionId=$SENDER_ID"
  [ -z "$READ_CONVERSATION_ID" ] || QUERY="$QUERY&conversation_id=$READ_CONVERSATION_ID"
  if [ -n "$COUNT" ]; then
    case "$COUNT" in *[!0-9]*) echo "forge.sh: n is a number (1-10)" >&2; exit 2;; esac
    QUERY="$QUERY&count=$COUNT"
  fi
  resolve_endpoint
  [ -f "$EP" ] || { echo "forge.sh: not reachable: open Forge with control_server and agent_bus enabled" >&2; exit 1; }
  URL="$(grep '"url"' "$EP" | cut -d'"' -f4)"
  TOKEN="$(grep '"token"' "$EP" | cut -d'"' -f4)"
  if ! READING="$(curl -sS --fail-with-body -X GET -H "Authorization: Bearer $TOKEN" "$URL/agent/$VERB?$QUERY")"; then
    # The body of a refused read is the reason, and capturing it moved it off the
    # terminal: print it, or the line after it blames itself ("see above").
    [ -z "${READING:-}" ] || printf '%s\n' "$READING" >&2
    echo "forge.sh: Forge's endpoint did not accept it (see above)." >&2
    exit 1
  fi
  printf '%s\n' "$READING" | report_waiting_verdicts "$NAME"
  exit 0
fi
if [ "$VERB" = "read-verdict" ] || [ "$VERB" = "ack-verdict" ]; then
  [ $# -eq 3 ] || usage
  NAME="$2"; EXCHANGE_ID="$3"
  case "$NAME" in ""|*[!A-Za-z0-9._-]*) echo "forge.sh: invalid sender" >&2; exit 2;; esac
  case "$EXCHANGE_ID" in ""|*[!A-Za-z0-9_-]*) echo "forge.sh: invalid exchange id" >&2; exit 2;; esac
  set_sender_identity "$NAME"
  resolve_endpoint
  [ -f "$EP" ] || { echo "forge.sh: not reachable: open Forge with control_server and agent_bus enabled" >&2; exit 1; }
  URL="$(grep '"url"' "$EP" | cut -d'"' -f4)"
  TOKEN="$(grep '"token"' "$EP" | cut -d'"' -f4)"
  IDENTITY_ARGS=()
  if [ -n "$SENDER_KIND" ]; then
    IDENTITY_ARGS+=(--data-urlencode "kind=$SENDER_KIND" --data-urlencode "sessionId=$SENDER_ID")
  fi
  if [ "$VERB" = "read-verdict" ]; then
    if ! VERDICT="$(curl -sS --fail-with-body -G -H "Authorization: Bearer $TOKEN" \
      --data-urlencode "from=$NAME" --data-urlencode "id=$EXCHANGE_ID" \
      "${IDENTITY_ARGS[@]}" \
      "$URL/agent/read-verdict")"; then
      [ -z "${VERDICT:-}" ] || printf '%s\n' "$VERDICT" >&2
      echo "forge.sh: verdict read failed" >&2
      exit 1
    fi
    printf '%s\n' "$VERDICT" | report_waiting_verdicts "$NAME"
  else
    if ! ACKED="$(curl -sS --fail-with-body -X POST -H "Authorization: Bearer $TOKEN" \
      --data-urlencode "from=$NAME" --data-urlencode "id=$EXCHANGE_ID" \
      "${IDENTITY_ARGS[@]}" \
      "$URL/agent/ack-verdict")"; then
      [ -z "${ACKED:-}" ] || printf '%s\n' "$ACKED" >&2
      echo "forge.sh: verdict acknowledgment failed" >&2
      exit 1
    fi
    printf '%s\n' "$ACKED" | report_waiting_verdicts "$NAME"
    echo
  fi
  exit 0
fi
if [ "$VERB" = "wait" ]; then
  # Block until the sender's chat is idle with nothing of theirs queued, then
  # print the final status and the latest answer so a supervising agent wakes
  # with the result. Polls /agent/status silently (no per-poll output); Ctrl-C
  # stops it. Exit 124 on timeout (last status to stderr), 1 on endpoint/auth
  # failure, 2 on bad arguments.
  NAME="${2:-}"; MINUTES=""; WAIT_CONVERSATION_ID=""
  [ $# -ge 2 ] || usage
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --to) [ $# -ge 2 ] && [ -z "$WAIT_CONVERSATION_ID" ] || usage; WAIT_CONVERSATION_ID="$2"; shift 2;;
      --*) usage;;
      *) [ -z "$MINUTES" ] || usage; MINUTES="$1"; shift;;
    esac
  done
  case "$NAME" in ""|*[!A-Za-z0-9._-]*) echo "forge.sh: a name is letters, digits, . _ - only" >&2; exit 2;; esac
  case "$WAIT_CONVERSATION_ID" in ""|*[!A-Za-z0-9._-]*) [ -z "$WAIT_CONVERSATION_ID" ] || { echo "forge.sh: bad conversation id '$WAIT_CONVERSATION_ID'" >&2; exit 2; };; esac
  if [ -n "$MINUTES" ]; then
    case "$MINUTES" in *[!0-9]*) echo "forge.sh: minutes is a positive whole number" >&2; exit 2;; esac
    [ "$MINUTES" -ge 1 ] || { echo "forge.sh: minutes is a positive whole number" >&2; exit 2; }
  fi
  # The sender identity first, because the window to poll is chosen by the
  # session link: reading endpoint.json before this would have polled whichever
  # window happened to be focused, not the one holding this session's chat.
  set_optional_sender_identity "$NAME"
  resolve_endpoint
  [ -f "$EP" ] || { echo "forge.sh: not reachable: open Forge with control_server and agent_bus enabled" >&2; exit 1; }
  URL="$(grep '"url"' "$EP" | cut -d'"' -f4)"
  TOKEN="$(grep '"token"' "$EP" | cut -d'"' -f4)"
  IDENTITY_ARGS=()
  if [ -n "$SENDER_KIND" ]; then
    IDENTITY_ARGS+=(--data-urlencode "kind=$SENDER_KIND" --data-urlencode "sessionId=$SENDER_ID")
  fi
  # --to names the chat to wait on, the same conversation_id the status and view
  # routes already take, so a session driving two Forge chats can wait on the one
  # it needs instead of the most recent one.
  TARGET_ARGS=()
  [ -z "$WAIT_CONVERSATION_ID" ] || TARGET_ARGS+=(--data-urlencode "conversation_id=$WAIT_CONVERSATION_ID")
  # ~55 s between polls: cheap for Forge, and a turn that ends between polls is
  # picked up on the next one. The test-only overrides keep route integration
  # tests deterministic without waiting for the production interval.
  POLL=55
  if [ -n "${FORGE_WAIT_POLL_MS:-}" ]; then
    case "$FORGE_WAIT_POLL_MS" in *[!0-9]*) echo "forge.sh: FORGE_WAIT_POLL_MS is a positive whole number of milliseconds" >&2; exit 2;; esac
    POLL_MS=$((10#$FORGE_WAIT_POLL_MS))
    [ "$POLL_MS" -ge 1 ] || { echo "forge.sh: FORGE_WAIT_POLL_MS is a positive whole number of milliseconds" >&2; exit 2; }
    POLL="$(printf '%d.%03d' "$((POLL_MS / 1000))" "$((POLL_MS % 1000))")"
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
    if LAST="$(curl -sS --fail-with-body -G -H "Authorization: Bearer $TOKEN" --data-urlencode "from=$NAME" "${IDENTITY_ARGS[@]}" "${TARGET_ARGS[@]}" "$URL/agent/status")"; then
      STATE="$(printf '%s\n' "$LAST" | sed -n 's/^State: //p' | head -n 1)"
      QUEUED="$(printf '%s\n' "$LAST" | sed -n 's/^Queued from you: //p' | head -n 1)"
      case "$STATE" in
        idle*)
          if [ "$QUEUED" = "0" ]; then
            printf '%s\n' "$LAST" | report_waiting_verdicts "$NAME"
            if ! WAIT_VIEW="$(curl -sS --fail-with-body -G -H "Authorization: Bearer $TOKEN" --data-urlencode "from=$NAME" --data-urlencode "count=1" "${IDENTITY_ARGS[@]}" "${TARGET_ARGS[@]}" "$URL/agent/view")"; then
              [ -z "${WAIT_VIEW:-}" ] || printf '%s\n' "$WAIT_VIEW" >&2
              echo "forge.sh: Forge's endpoint did not accept it (see above)." >&2
              exit 1
            fi
            printf '%s\n' "$WAIT_VIEW" | report_waiting_verdicts "$NAME"
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
  set_sender_identity "$NAME"
  [ -n "$SENDER_KIND" ] || { echo "forge.sh: send-file requires an agent session identity" >&2; exit 2; }
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
  resolve_endpoint
  [ -f "$EP" ] || { echo "forge.sh: not reachable: open Forge with control_server and agent_bus enabled" >&2; exit 1; }
  URL="$(grep '"url"' "$EP" | cut -d'"' -f4)"
  TOKEN="$(grep '"token"' "$EP" | cut -d'"' -f4)"
  SEND_ARGS=(
    -sS --fail-with-body -X POST
    -H "Authorization: Bearer $TOKEN"
    --data-urlencode "from=$NAME"
    --data-urlencode "sender_kind=$SENDER_KIND"
    --data-urlencode "sender_session_id=$SENDER_ID"
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
ARG=""; SRC="-"; MODEL=""; NEW_CHAT=""; CONVERSATION_ID=""; TO_RUNNING=""; ORIGIN_CONVERSATION=""; FORCE=""
if [ "$VERB" = "say" ]; then
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --model) [ $# -ge 2 ] || usage; MODEL="$2"; shift 2;;
      --new) NEW_CHAT=true; shift;;
      # Temporary (added 2026-11-16, v0.17.183): remove this --unattended line and its test
      # ("refuses the removed say --unattended flag", test/unit/AgentBus.test.ts) after
      # 2026-12-16, once old notes that still pass the flag have aged out. The --*) usage
      # line below then refuses it.
      --unattended) echo "forge.sh: --unattended was removed. A chat you start with say --new runs in Clanker mode, which still asks the owner before destructive actions, Forge guard files, skill writes, and a secret read followed by egress." >&2; exit 2;;
      --to) [ $# -ge 2 ] || usage; CONVERSATION_ID="$2"; shift 2;;
      --to-running) TO_RUNNING=true; shift;;
      --*) usage;;
      *) if [ -z "$ARG" ]; then ARG="$1"; elif [ "$SRC" = "-" ]; then SRC="$1"; else usage; fi; shift;;
    esac
  done
  [ -n "$ARG" ] || usage
  set_sender_identity "$ARG"
elif [ "$VERB" = "send" ] || [ "$VERB" = "steer" ]; then
  ARG="$2"
  [ $# -ge 3 ] || usage
  TO="$3"; shift 3
  while [ $# -gt 0 ]; do
    case "$1" in
      --to) [ "$TO" = "forge" ] && [ $# -ge 2 ] || usage; CONVERSATION_ID="$2"; shift 2;;
      --to-running) [ "$VERB" = "send" ] && [ "$TO" = "forge" ] || usage; TO_RUNNING=true; shift;;
      --*) usage;;
      *) [ "$SRC" = "-" ] || usage; SRC="$1"; shift;;
    esac
  done
  case "$TO" in ""|*[!A-Za-z0-9._-]*) echo "forge.sh: bad recipient '$TO'" >&2; exit 2;; esac
  case "$TO" in claude|codex|copilot) set_sender_identity "$ARG";; esac
  if [ "$TO" = "forge" ]; then
    set_sender_identity "$ARG"
  fi
  if [ "$VERB" = "send" ] && [ -n "${FORGE_CONVERSATION_ID:-}" ]; then
    case "$FORGE_CONVERSATION_ID" in
      *[!A-Za-z0-9._-]*) echo "forge.sh: invalid FORGE_CONVERSATION_ID; origin_conversation was not forwarded" >&2;;
      *) ORIGIN_CONVERSATION="$FORGE_CONVERSATION_ID";;
    esac
  fi
elif [ "$VERB" = "stop" ]; then
  ARG="$2"; shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --to) [ $# -ge 2 ] && [ -z "$CONVERSATION_ID" ] || usage; CONVERSATION_ID="$2"; shift 2;;
      *) usage;;
    esac
  done
  set_sender_identity "$ARG"
  SRC=/dev/null
elif [ "$VERB" = "reload" ]; then
  ARG="$2"; shift 2
  REOPEN_CLAUDE_SESSION=""
  REOPEN_CLAUDE_SET=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --to) [ $# -ge 2 ] && [ -z "$CONVERSATION_ID" ] || usage; CONVERSATION_ID="$2"; shift 2;;
      --force) [ -z "$FORCE" ] || usage; FORCE=true; shift;;
      --reopen-claude) [ $# -ge 2 ] && [ -z "$REOPEN_CLAUDE_SET" ] || usage; REOPEN_CLAUDE_SESSION="$2"; REOPEN_CLAUDE_SET=true; shift 2;;
      *) usage;;
    esac
  done
  [ -n "$CONVERSATION_ID" ] || usage
  if [ -n "$REOPEN_CLAUDE_SET" ]; then
    printf '%s' "$REOPEN_CLAUDE_SESSION" | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' || {
      echo "forge.sh: bad Claude session id '$REOPEN_CLAUDE_SESSION'" >&2
      exit 2
    }
  fi
  set_sender_identity "$ARG"
  SRC=/dev/null
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
         ROUTE=message; QUERY="from=$ARG$SENDER_QUERY"; [ -n "$MODEL" ] && QUERY="$QUERY&model=$MODEL"; [ -n "$NEW_CHAT" ] && QUERY="$QUERY&new_chat=true"; [ -n "$CONVERSATION_ID" ] && QUERY="$QUERY&conversation_id=$CONVERSATION_ID"; [ -n "$TO_RUNNING" ] && QUERY="$QUERY&to_running=true" ;;
  send)  case "$ARG" in ""|*[!A-Za-z0-9._-]*) echo "forge.sh: a name is letters, digits, . _ - only" >&2; exit 2;; esac
         case "$CONVERSATION_ID" in ""|*[!A-Za-z0-9._-]*) [ -z "$CONVERSATION_ID" ] || { echo "forge.sh: bad conversation id '$CONVERSATION_ID'" >&2; exit 2; };; esac
         [ -z "$CONVERSATION_ID" ] || [ -z "$TO_RUNNING" ] || usage
         ROUTE=message; QUERY="from=$ARG&to=$TO$SENDER_QUERY"; [ -n "$CONVERSATION_ID" ] && QUERY="$QUERY&conversation_id=$CONVERSATION_ID"; [ -n "$TO_RUNNING" ] && QUERY="$QUERY&to_running=true"; [ -n "$ORIGIN_CONVERSATION" ] && [ "$TO" != "forge" ] && QUERY="$QUERY&origin_conversation=$ORIGIN_CONVERSATION" ;;
  steer) case "$ARG" in ""|*[!A-Za-z0-9._-]*) echo "forge.sh: a name is letters, digits, . _ - only" >&2; exit 2;; esac
         case "$CONVERSATION_ID" in ""|*[!A-Za-z0-9._-]*) [ -z "$CONVERSATION_ID" ] || { echo "forge.sh: bad conversation id '$CONVERSATION_ID'" >&2; exit 2; };; esac
         ROUTE=message; QUERY="from=$ARG&to=$TO$SENDER_QUERY&priority=steer"; [ -n "$CONVERSATION_ID" ] && QUERY="$QUERY&conversation_id=$CONVERSATION_ID" ;;
  stop)  case "$ARG" in ""|*[!A-Za-z0-9._-]*) echo "forge.sh: a name is letters, digits, . _ - only" >&2; exit 2;; esac
         case "$CONVERSATION_ID" in ""|*[!A-Za-z0-9._-]*) [ -z "$CONVERSATION_ID" ] || { echo "forge.sh: bad conversation id '$CONVERSATION_ID'" >&2; exit 2; };; esac
         ROUTE=stop; QUERY="from=$ARG$SENDER_QUERY"; [ -n "$CONVERSATION_ID" ] && QUERY="$QUERY&conversation_id=$CONVERSATION_ID"; SRC=/dev/null ;;
  reload) case "$ARG" in ""|*[!A-Za-z0-9._-]*) echo "forge.sh: a name is letters, digits, . _ - only" >&2; exit 2;; esac
          case "$CONVERSATION_ID" in ""|*[!A-Za-z0-9._-]*) echo "forge.sh: bad conversation id '$CONVERSATION_ID'" >&2; exit 2;; esac
          ROUTE=reload; QUERY="from=$ARG$SENDER_QUERY&conversation_id=$CONVERSATION_ID"; [ -n "$FORCE" ] && QUERY="$QUERY&force=true"; [ -n "$REOPEN_CLAUDE_SET" ] && QUERY="$QUERY&reopen_claude_session=$REOPEN_CLAUDE_SESSION"; SRC=/dev/null ;;
  cancel) case "$ARG" in ""|*[!A-Za-z0-9._-]*) echo "forge.sh: a name is letters, digits, . _ - only" >&2; exit 2;; esac
         [ $# -eq 3 ] || usage
         case "$3" in ""|*[!A-Za-z0-9_-]*) echo "forge.sh: bad id '$3' (the id say printed, or all)" >&2; exit 2;; esac
         ROUTE=cancel; QUERY="from=$ARG&id=$3"; SRC=/dev/null ;;
  *) usage ;;
esac
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
if [ "$SRC" = "-" ]; then cat > "$TMP"; else cp "$SRC" "$TMP" || exit 2; fi
if [ "$VERB" = "reload" ]; then resolve_reload_endpoint; else resolve_endpoint; fi
if [ -f "$EP" ]; then
  URL="$(grep '"url"' "$EP" | cut -d'"' -f4)"
  TOKEN="$(grep '"token"' "$EP" | cut -d'"' -f4)"
  if [ "$VERB" = "reload" ]; then
    if RESULT="$(curl -sS --fail-with-body -X POST -H "Authorization: Bearer $TOKEN" \
        -H "Content-Type: text/plain; charset=utf-8" --data-binary "@$TMP" "$URL/agent/$ROUTE?$QUERY" 2>/dev/null)"; then
      printf '%s\n' "$RESULT"
      exit 0
    fi
    if [ -n "${RESULT:-}" ]; then printf '%s\n' "$RESULT" >&2
    else echo "forge.sh: Forge's endpoint did not accept reload." >&2; fi
    exit 1
  fi
  if RESULT="$(curl -sS --fail-with-body -X POST -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: text/plain; charset=utf-8" --data-binary "@$TMP" "$URL/agent/$ROUTE?$QUERY")"; then
    printf '%s\n' "$RESULT" | report_waiting_verdicts "$ARG"
    exit 0
  fi
  [ -z "${RESULT:-}" ] || printf '%s\n' "$RESULT" >&2
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
