# Agent bus: `status` and `view` — see what Forge is doing mid-turn

Status: PROPOSED 2026-09-22 (written by Claude Code from the HalluScribe session). Not started.
Closes the last open item of `docs/TODO-agent-bus-steer-and-queue-visibility.md` §6 (`/status`, `/view` over the bus).
Implementer: Forge (local Qwen). Reviewer: Claude or Codex.

---

## 1. Why

A supervisor (Claude Code, Codex) that sent Forge a task through the bus can already:

- see busy / idle / dead per agent — `forge.sh who`;
- get a one-line notice when the turn ends — `busTurnEndLine`, `src/agentBus/agentInbox.ts`;
- receive progress notes the model chooses to send — `tell_live_session`;
- interrupt it — `forge.sh steer`.

It cannot see **what a running turn is doing**: which tool it is on, how many tool calls so far, what it last said, whether
a warning such as "repeating the same tool call" fired, how full its context is. Telegram has all of this (`/status`, `/view`,
the live progress bubble), the bus has none of it. A turn that is busy for 40 minutes looks the same from the bus whether it is
making progress or stuck in a loop.

This plan adds two **read-only** bus commands:

```
forge.sh status <your-name>          what the chat you are talking to is doing right now
forge.sh view   <your-name> [n]      the last n answers in that chat (default 3, max 10)
```

Both answer about **the sender's own chat only** — the conversation `busTarget` already routes that sender's messages to.

## 2. Non-goals (do NOT build these)

- No `/stop`, `/compact`, or any other command that changes state. `steer` and `cancel` already exist.
- No status file on disk, no `update_plan` mirroring, no push notifications. In-memory only.
- No change to the Telegram `/status` or `/view` output.
- No access to other chats. **No fallback to the active chat** when the sender has none (see §4.1).
- No change to `src/extension.ts` (498 lines — it must not grow).
- No new dependency.

## 3. Design in one paragraph

A small in-memory watcher (`BusTurnWatch`) subscribes to the host's existing `onAgentProgress` event stream and keeps one
snapshot per conversation: when the current turn started, the last event time, the tool-call count, the last tool name, the
last narration, the current phase, latched warnings, and how the last turn ended. Two new GET routes on the existing
control server, `/agent/status` and `/agent/view`, resolve the sender's chat, render plain text from that snapshot plus
data the host facade already exposes, and return it as `text/plain`. `forge.sh` gets two verbs that print the text. Every
formatter that already exists is reused: `describeBudget`, `parseViewCount`, `renderExchange`, `MAX_VIEW_COUNT`.

## 4. Decisions (already made — do not re-decide)

### 4.1 Scope = the sender's chat, no fallback
`busTargetConversation` (`src/agentBus/busTarget.ts`) falls back to the **active** conversation when the sender has none.
That fallback is right for *delivering* a message and wrong for *reading*: it would show any bus agent whatever the user
happens to have open. The read routes use a new `senderConversation` that returns `undefined` instead, and the route answers
**404** `no chat holds a message from "<from>": send one with forge.sh say first`.

### 4.2 Why a new watcher and not `RemoteAgentProgress`
`src/remote/RemoteAgentProgress.ts` consumes the same events, but it is a Telegram message editor: it owns a channel, a
message id, edit timers and delivery. The watcher is a transport-free snapshot. They share an input type, not logic. Do
**not** import `RemoteAgentProgress`; do **not** copy its rendering. Put one sentence in the watcher's doc comment saying this.

### 4.3 The watcher attaches lazily
`setupAgentMessaging` runs before the sidebar exists (`src/extension.ts` builds the control server first). So the watcher
cannot subscribe at construction. `attach(facade)` is idempotent and is called (a) in the inbox `submit` before a bus
turn starts, and (b) at the start of every `status`/`view` request. A turn that began before the first attach has no
snapshot; `status` says so honestly (§6.3) instead of inventing one.

### 4.4 The model's streamed words are never stored
`commentary` events (token stream) only update `lastEventAt`. Only finished `narration` text is kept, clipped.

### 4.5 Plain text, rendered by the host
The host owns the format; `forge.sh` prints the body as-is. No JSON parsing in bash (the `who` awk parser is the example
of what not to repeat). Errors stay JSON `{error}` like every other bus route, and `forge.sh` prints them to stderr.

---

## 5. Phase 1 — pure modules + unit tests (one commit)

Commit message: `feat(agent-bus): turn watcher, sender-scoped chat lookup, status/view renderers`

### 5.1 `src/agentBus/busTarget.ts` — extract `senderConversation`

Add, above `busTargetConversation`:

```ts
/**
 * The open chat already holding a prompt from `from`, most recently updated first, or
 * undefined. The READ routes (`/agent/status`, `/agent/view`) use this directly: unlike
 * delivery, reading must never fall back to the active chat (AGENT_BUS_STATUS_VIEW_PLAN §4.1).
 */
export function senderConversation(
  from: string,
  status: Pick<ForgeHostStatus, 'conversations'>,
  exchanges: (conversationId: string) => ForgeExchange[],
): string | undefined
```

Its body is exactly the current loop in `busTargetConversation` (lower-case sender, skip archived, sort by `updatedAt`
desc, title prefix `"<sender>: "` or an exchange whose `parseForgeInboundPrompt(...).from` matches), returning `conv.id` or
`undefined`. Then `busTargetConversation` becomes:

```ts
if (!from) return status.activeConversationId;
return senderConversation(from, status, exchanges) ?? status.activeConversationId;
```

Keep `busTargetConversation`'s doc comment. Behaviour must not change: **`test/unit/busTarget.test.ts` must pass without
edits.** Add to that file a `describe('senderConversation', …)` with:
- returns `undefined` when no open chat holds a prompt from the sender (while an active conversation exists);
- skips an archived chat that holds the sender's prompt;
- matches by title prefix;
- is case-insensitive on the sender.

### 5.2 New `src/agentBus/busTurnWatch.ts` (target ≤ 170 lines)

Header comment in the repo's usual style (look at the top of `busTarget.ts`). Import only `AgentProgressEvent` from
`../sidebar/AgentProgress` and nothing from `src/remote/`.

```ts
/** Per-turn caps. Local to the bus: RemoteAgentProgress's caps are private to Telegram. */
export const MAX_TOOL_NAME_CHARS = 80;
export const MAX_NARRATION_CHARS = 300;
export const MAX_WARNINGS = 4;
/** Conversations remembered; the least recently active is dropped past this. */
export const MAX_WATCHED = 20;

export interface TurnSnapshot {
  state: 'running' | 'ended';
  startedAt: number;       // ms epoch of the first event of this turn
  lastEventAt: number;     // ms epoch of the latest event of any kind
  toolCalls: number;       // `tool` events this turn
  lastTool?: string;
  lastNarration?: string;  // one line, clipped
  phase?: string;          // latest `phase` text; undefined = default
  warnings: string[];      // latest MAX_WARNINGS `notice` warnings, oldest first
  endedOk?: boolean;       // set by `end`
  endedAt?: number;        // set by `end`
}

export function reduceTurn(
  prev: TurnSnapshot | undefined,
  event: AgentProgressEvent,
  now: number,
): TurnSnapshot
```

`reduceTurn` rules — pure, no clock reads, returns a new object (never mutates `prev`):

1. If `prev` is `undefined` **or** `prev.state === 'ended'`, and `event.kind !== 'end'`: start a fresh snapshot
   `{ state: 'running', startedAt: now, lastEventAt: now, toolCalls: 0, warnings: [] }`, then apply rule 3.
2. If `prev` is `undefined` and `event.kind === 'end'`: return
   `{ state: 'ended', startedAt: now, lastEventAt: now, toolCalls: 0, warnings: [], endedOk: event.ok, endedAt: now }`.
3. Always set `lastEventAt = now`. Then by `event.kind`:
   - `tool` → `toolCalls + 1`; `lastTool = clip(event.toolName, MAX_TOOL_NAME_CHARS)`.
   - `narration` → `lastNarration = clip(oneLine(event.text), MAX_NARRATION_CHARS)`; if that is empty, leave it unchanged.
   - `phase` → `phase = event.text` (undefined clears it).
   - `notice` with `severity === 'warning'` → append `clip(oneLine(event.text), MAX_NARRATION_CHARS)`, keep the last `MAX_WARNINGS`.
   - `notice` with `severity === 'info'`, `commentary`, `status` → nothing else (timestamp only). **Never store `commentary` text.**
   - `end` → `state = 'ended'`, `endedOk = event.ok`, `endedAt = now`. Keep the counters: they describe the turn that just ended.

`oneLine` collapses every run of whitespace (including newlines) to one space and trims. `clip(text, max)` returns `text`
if it fits, else `text.slice(0, max - 1).trimEnd() + '…'`. Both are private to this file. **Grep first**
(`rg "function oneLine|function clip" src`); if a transport-free helper already exists in `src/util/`, import it instead.

```ts
export interface ProgressSource {
  onAgentProgress?(listener: (event: AgentProgressEvent) => void): { dispose(): void };
}

export class BusTurnWatch {
  constructor(private readonly now: () => number = Date.now) {}
  /** Subscribe once. Later calls are no-ops. False if the source has no progress stream. */
  attach(source: ProgressSource): boolean;
  /** True once `attach` has subscribed successfully. */
  get attached(): boolean;
  snapshot(conversationId: string): TurnSnapshot | undefined;
  dispose(): void;
}
```

- `attach`: if already subscribed, return `true`. If `source.onAgentProgress` is undefined, return `false` and stay
  unsubscribed (the next call may try again). Otherwise subscribe, store the disposable, return `true`.
- The listener does `map.set(id, reduceTurn(map.get(id), event, this.now()))`, then, if `map.size > MAX_WATCHED`, deletes
  the entry with the smallest `lastEventAt`.
- `dispose()` disposes the subscription and clears the map. Make it satisfy `{ dispose(): void }` so it can go into
  `context.subscriptions`.

Tests: new `test/unit/busTurnWatch.test.ts`, one `it` per rule above, plus:
- a full turn `tool, narration, tool, notice(warning), end(ok)` → `toolCalls 2`, last tool, narration, 1 warning, `ended`, `endedOk true`;
- the next event after `end` starts a fresh turn with `toolCalls 0` and a new `startedAt`;
- `commentary` with text `"SECRET"` leaves no field containing `"SECRET"` (check `JSON.stringify(snapshot)`);
- a 1000-character narration with newlines is clipped to `MAX_NARRATION_CHARS` and has no `\n`;
- 6 warnings keep the last 4, in order;
- `BusTurnWatch` with a fake source: `attach` returns true, a second `attach` does not subscribe twice (count the calls),
  a source without `onAgentProgress` returns false, `MAX_WATCHED + 1` conversations evict the least recently active one,
  and `dispose` calls the fake's dispose.

### 5.3 New `src/agentBus/busStatusView.ts` (target ≤ 160 lines)

Pure renderers. Imports allowed: `TurnSnapshot` (busTurnWatch), `describeBudget` (`../remote/RemoteSessionCommands`),
`renderExchange` + `MAX_VIEW_COUNT` (`../remote/RemoteTranscriptView`), `ForgeExchange` type. **Reuse these; do not copy them.**

```ts
export interface BusStatusInput {
  conversation: {
    id: string;
    title: string;
    activeModel?: string | undefined;
    requestCount?: number | undefined;
    toolCallCount?: number | undefined;
  };
  streaming: boolean;                                  // this conversation is mid-turn
  queuedFromSender: number;                            // sender's messages not yet started
  budget: { used: number; max: number } | undefined;
  turn: TurnSnapshot | undefined;
  watchAttached: boolean;
  now: number;
}
export function renderBusStatus(input: BusStatusInput): string
```

Output: lines joined with `\n`, no trailing newline, in this order. A line marked *(if …)* is omitted otherwise.

```
Chat: <title> · <id>
State: <see below>
Model: <activeModel ?? 'default'>
Now: <phase ?? 'working'> · last tool <lastTool ?? 'none yet'> · <toolCalls> tool call(s) this turn   (if streaming && turn?.state === 'running')
Said: <lastNarration>                                                                (if streaming && turn?.lastNarration)
Warnings: <w1> | <w2> | …                                                            (if turn && turn.warnings.length > 0)
Context: <describeBudget(budget)>
Queued from you: <queuedFromSender>
Work: <requestCount ?? 0> model request(s), <toolCallCount ?? 0> tool call(s) in this chat
```

`State:` rules, first match wins:
1. `streaming && turn?.state === 'running'` → `busy · turn running <dur(now - startedAt)> · last activity <dur(now - lastEventAt)> ago`
2. `streaming && !watchAttached` → `busy · live detail unavailable (the watcher is not attached yet)`
3. `streaming` → `busy · this turn started before the watcher attached; no live detail`
4. `turn?.state === 'ended'` → `idle · last turn ended <ok ? 'ok' : 'with an error'> <dur(now - endedAt)> ago after <dur(endedAt - startedAt)>, <toolCalls> tool call(s)`
5. otherwise → `idle`

`dur(ms)`: under 60 s → `<s> s`; under 60 min → `<m> min`; else `<h> h <m> min`. Round down. Negative → `0 s`.

Rule 1 deliberately does not say "stalled": the supervisor judges from "last activity N ago". Do not add a stall threshold.

```ts
export function renderBusView(
  exchanges: readonly ForgeExchange[],
  options: { clamped: boolean; streaming: boolean },
): string
```

- Empty `exchanges` → `No answers in this chat yet.` (plus the streaming note below, if streaming).
- Otherwise each exchange is `renderExchange(exchange, index + 1, exchanges.length)` (no `note` argument), joined with
  `\n\n---\n\n`, oldest first (the order the host already returns).
- Prepend these lines when they apply, then a blank line:
  - clamped → `Note: showing the last ${MAX_VIEW_COUNT}, the maximum.`
  - streaming → `Note: a turn is running; the last entry may be partial.`

Tests: new `test/unit/busStatusView.test.ts`, one test per `State:` rule, plus:
- idle chat with no turn → exactly 6 lines (Chat, State, Model, Context, Queued, Work);
- `dur` boundaries: 59 s, 60 s, 59 min, 60 min, 125 min → `59 s`, `1 min`, `59 min`, `1 h 0 min`, `2 h 5 min`;
- the `Context:` line equals `'Context: ' + describeBudget(budget)` for a budget and for `undefined`;
- `renderBusView`: empty, clamped, streaming, 2 exchanges (the separator appears once; `[1/2]` comes before `[2/2]`).

### 5.4 Phase 1 gate
`npm run ci` green, `git diff --check` clean. Commit only the files of this phase, by name (never `git add -A`).
No wiring yet: the new modules have no production caller in this phase, which is expected. If lint flags an unused export,
report it; do not add a fake caller.

---

## 6. Phase 2 — routes, wiring, client, docs (one commit)

Commit message: `feat(agent-bus): forge.sh status / view — read what the sender's chat is doing`

### 6.1 `src/agentBus/agentInbox.ts` — per-sender queue count

Add next to `get pending()`:

```ts
/** How many of `from`'s messages are queued and not yet started. */
pendingFrom(from: string): number {
  return this.queue.filter((item) => item.from === from).length;
}
```

Test in `test/unit/AgentInbox.test.ts`: two senders, three queued messages → `pendingFrom` 2 and 1, and 0 for an unknown sender.

### 6.2 `src/backend/controlHttp.ts` — `sendText`

Grep first (`rg "text/plain" src/backend`). If no helper exists, add beside `sendJson`:

```ts
export function sendText(res: http.ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text.endsWith('\n') ? text : `${text}\n`);
}
```

### 6.3 `src/backend/agentRoutes.ts` — two GET routes (file stays ≤ 430 lines; it is 369 now)

Add to `AgentRoutesDeps`:

```ts
/**
 * AGENT_BUS_STATUS_VIEW_PLAN: read-only views of the SENDER's chat. The host renders the text.
 * Absent ⇒ the route is 404.
 */
status?: (from: string) => BusReadResult | Promise<BusReadResult>;
view?: (from: string, count: string | undefined) => BusReadResult | Promise<BusReadResult>;
```

and export:

```ts
export type BusReadResult =
  | { ok: true; text: string }
  | { ok: false; status: 400 | 404; error: string };
```

In `handle`:
1. Add `(route === '/agent/status' && !!this.deps.status) || (route === '/agent/view' && !!this.deps.view)` to `known`.
2. Put the new branch right after the existing `/agent/who` branch (after the auth check, so a missing token is still 401):
   - `req.method !== 'GET'` → 405 `{ error: 'GET only' }`.
   - `from = (url.searchParams.get('from') ?? '').trim()`; fails `FROM_PATTERN` → 400 with the **same** message the POST routes use.
   - `await this.deps.validateFrom?.(from)`; not ok → 400 with its error.
   - Call the dep. The view route passes `url.searchParams.get('count') ?? undefined`.
   - `ok` → `sendText(res, 200, result.text)`; not ok → `sendJson(res, result.status, { error: result.error })`.
3. Add both routes to the class doc comment's route list:
   `GET /agent/status ?from → 200 text (the sender's chat, now)` and `GET /agent/view ?from&count → 200 text (its last answers)`.

Do not restructure the POST path. If the file would pass 430 lines, move the new branch into a private method
`handleRead(route, req, url, res)` in the same file. Do not create a new file for it.

Tests in `test/unit/AgentRoutes.test.ts`, following that file's existing helpers for a request with or without a token:
- deps absent → 404 for both routes;
- no token → 401; POST → 405;
- `from=bad!name` → 400; a `validateFrom` that refuses → 400 with its message;
- a dep returning `{ ok: false, status: 404, error: 'x' }` → 404 JSON `{ error: 'x' }`;
- a dep returning `{ ok: true, text: 'hello' }` → 200, `content-type` starts with `text/plain`, body `hello\n`;
- the view route passes `count` through as a string, and `undefined` when absent.

### 6.4 `src/vscode/agentMessagingSetup.ts` — wiring (file stays ≤ 230 lines; it is 144 now)

1. `const watch = new BusTurnWatch(); context.subscriptions.push(watch);` next to where the inbox is created.
2. In the inbox `submit`, right after `const facade = getSidebar().getHostFacade();`, add `watch.attach(facade);`.
   Ignore its boolean there: submit must not change behaviour.
3. Add a local `readTarget(from)` helper:
   ```ts
   const facade = getSidebar().getHostFacade();
   watch.attach(facade);
   const status = facade.status();
   const id = senderConversation(from, status, (cid) => facade.recentExchanges(cid, BUS_TARGET_SCAN));
   ```
   If `id` is `undefined`, return
   `{ ok: false, status: 404, error: \`no chat holds a message from "${from}": send one with forge.sh say first\` }`.
   Otherwise return `{ facade, status, id, conversation: status.conversations.find((c) => c.id === id) }`.
   If `conversation` is `undefined` (the chat closed between two calls), return the same 404 with
   `the chat for "${from}" is no longer open`.
4. `status` dep: `renderBusStatus({ conversation, streaming: status.streamingConversationIds.includes(id),
   queuedFromSender: inbox.pendingFrom(from), budget: facade.contextBudget(id), turn: watch.snapshot(id),
   watchAttached: watch.attached, now: Date.now() })`. Take the conversation fields the renderer needs from `conversation`:
   they are the same fields Telegram `/status` reads (`title`, `id`, `activeModel`, `requestCount`, `toolCallCount`).
   If a field does not exist on the type, **stop and report**; do not cast.
5. `view` dep: `const requested = parseViewCount(count)`; `invalid` →
   `{ ok: false, status: 400, error: \`count must be 1-${MAX_VIEW_COUNT}\` }`; else
   `renderBusView(facade.recentExchanges(id, requested.count), { clamped: requested.clamped, streaming })`.
6. Pass `status` and `view` into `new AgentRoutes({...})`.

`from` inside these deps is the same string `validateFrom` accepted. Do not lower-case it before `pendingFrom`: the inbox
stores `from` exactly as sent, and `senderConversation` already lower-cases internally.

### 6.5 `src/agentBus/forge.sh` — two verbs

Usage block (the leading comment; `usage()` derives it, so just add lines), after the `who` line:

```
#   forge.sh status <your-name>       what your chat with Forge is doing now (tool, last words, context)
#   forge.sh view <your-name> [n]     the last n answers in your chat (default 3, max 10)
```

Implementation: a branch right after the `who` branch, modelled on it (GET, no body), shared by both verbs:

```bash
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
```

`--fail-with-body` prints the JSON error body and exits non-zero, which is what we want. Keep the file LF-only (a test checks).

Test in `test/unit/AgentBus.test.ts`: add `'status'` and `'view'` to the verb list in
`'covers every verb and the text-source note'`. The existing "valid bash" test covers the syntax.

### 6.6 README (`src/agentBus/busContent.ts`)

The README Forge writes to `~/.forge/agent-bus/README.md` comes from this file. Add a section after `## Who is in the mesh`:

```
## Watching a running turn

`bash ~/.forge/agent-bus/forge.sh status <your-name>` shows what YOUR chat with Forge is doing:
busy or idle, how long the turn has run, seconds since its last activity, the tool it is on, how
many tool calls so far, the last thing it said, any warnings, and context use. `view <your-name> [n]`
replays the last n answers (default 3, max 10). Both read only the chat your own messages went to;
if you have not sent Forge anything yet there is nothing to show. Each is one small request and
costs Forge no model tokens, so use it instead of messaging Forge to ask how it is going.
```

Watch the escaping: busContent.ts holds the README in a template literal, so backticks are written `` \` `` there,
like the existing sections.

### 6.7 Docs
- `docs/TODO-agent-bus-steer-and-queue-visibility.md` §6: under the `forge.sh cmd` bullet add
  `→ DONE as forge.sh status / view (docs/plans/AGENT_BUS_STATUS_VIEW_PLAN.md); /stop and /compact deliberately not exposed.`
- This plan: set `Status:` to `DONE <date>, <commit hashes>` and fill §9.
- Do **not** bump the version. Do **not** edit `CHANGELOG.md` (generated). If `CHANGES.md` has an `Unreleased` heading,
  add one line under it; if not, leave it for the release.

### 6.8 Phase 2 gate
`npm run ci` green, `npm run package` green, `git diff --check` clean, `git status` shows no stray files.
Commit by file name.

---

## 7. Live check (after Phase 2, Forge reloaded)

Run from Git Bash, as described in AGENTS.md (never a bare `bash` from PowerShell):

1. `forge.sh status claude` from a sender with no chat → 404 message, exit 1.
2. `forge.sh say claude` a task that takes a few minutes (e.g. "read src/agentBus/*.ts and summarise each file").
3. While it runs, call `forge.sh status claude` 3 times, ~20 s apart: `State: busy`, the tool count rises, `last activity` stays small.
4. After the finished notice: `State: idle · last turn ended ok …`.
5. `forge.sh view claude 2` → the last two answers; `view claude 0` → 400; `view claude 50` → the last 10 plus the clamped note.
6. Confirm the user's own active chat (a different tab) is never what `status` describes.

Paste the output of 1, 3 (one of the three), 4 and 5 into the report.

## 8. Rules for the implementer (read before starting)

- **No silent error handling.** No `catch {}`, no `catch { return undefined }`, no `let _ =` on a Result-like value, no
  `.catch(() => {})`. If something can fail, return a `BusReadResult` error or let it throw to the route's existing handler.
  This is the defect class that bounced most of the last run's phases; the reviewer greps for it.
- **Reuse, don't copy:** `describeBudget`, `parseViewCount`, `renderExchange`, `MAX_VIEW_COUNT`, `sendJson`, `FROM_PATTERN`,
  the `who` branch shape in forge.sh. If you believe one of them doesn't fit, stop and ask; do not write a second version.
- **Report only what you ran.** The report quotes the real `npm run ci` summary lines (test counts, exit status). If a step
  was skipped, the report says "skipped" and why. Do not describe behaviour you did not test.
- **Stop and ask (BLOCKED)** instead of guessing if: a type named here doesn't have the field the plan says; a file would
  cross 500 lines; a test in §5/§6 contradicts existing behaviour; lint rejects an import direction
  (`src/agentBus` → `src/remote`).
- Stage files by name. Never `git add -A`. Never branch. One phase = one commit.
- After each phase: write `docs/plans/AGENT_BUS_STATUS_VIEW.report.md` (append a section per phase): commit hash, files
  touched with line counts, CI summary, any deviation from this plan and why. Then stand by for review.

## 9. Acceptance checklist

- [ ] `senderConversation` exists; `busTargetConversation` delegates to it; the old busTarget tests pass unedited.
- [ ] `reduceTurn` is pure; `commentary` text is never stored; warnings are capped at 4; the map is capped at 20.
- [ ] `renderBusStatus` follows the five `State:` rules in order; `renderBusView` reuses `renderExchange`.
- [ ] `GET /agent/status` and `GET /agent/view` need the token, GET only, validate `from`, answer `text/plain`.
- [ ] A sender with no chat gets 404; the active chat is never used as a fallback.
- [ ] `forge.sh status|view` are in the usage block, validate their args, and print errors to stderr with exit 1.
- [ ] The README section exists; the TODO §6 is marked done.
- [ ] `src/extension.ts` untouched; no file over 500 lines; no new dependency.
- [ ] Live check §7 done and pasted into the report.

## 10. State × lifecycle ledger

No durable state. `BusTurnWatch` holds an in-memory map (≤ 20 conversations) that is lost on window reload, by design:
after a reload `status` reports "this turn started before the watcher attached" until the next event arrives. Nothing is
written to disk, `endpoint.json` is not changed, and the bus inbox/outbox files are untouched