# One Forge chat, one Claude / Codex / Copilot session — for good

Status: **implemented; commits: phase 1 `92219b3`, phase 2 `4c2be22`, phase 3 `1f6ae00`, phase 4 `13ef7de`, phase 5 (deletions) the commit that follows `13ef7de`.**
Final review pass 2026-10-08 — see "Review corrections" at the end. Supersedes the
routing half of `AGENT_BUS_CHAT_AFFINITY_PLAN.md` (sender-name routing) and the
alias resolution in `REMOTE_SESSION_REPLY_PLAN.md`; both stay valid for the
parts not named here.

**Scope (decided 2026-10-08): everything below applies equally to Claude and
Codex. Copilot gets the same where its CLI allows it** — phase 0(e) says where
it does not, and there Copilot keeps working through the closest available
path, with the gap shown in the chat header.

## The problem, in the owner's words

> Claude or Codex sends a message to Forge from a specific session — Forge
> replies to that specific session, and I can watch Forge's messages there, or
> at least see that Claude has received them. If Forge starts a new chat and I
> tell it "ask Claude" (or Codex, or whatever), it opens a new session with them
> and that stays forever. If I go back to that Forge chat after a week and say
> "talk again with Claude", it uses the session it used a week ago.

Today none of that is guaranteed, because several routes reach the same agents
and each picks the target session by its own rule:

| Route | How it picks the session | Remembered for |
|---|---|---|
| `ask_local_agent` with a CLI target (`CliSessionRegistry`) | keyed `(conversationId, modelName)` | 15 min idle, in memory — gone on reload |
| `ask_live_session` / `tell_live_session` | `target: "claude"` = the global mesh alias, or a session name the model types | alias lifetime (global, not per chat) |
| Agent mesh (`forge.sh send <name> <to>`, stand-ins, owned sessions `ClaudeOwnedSession` / `CodexAppServerSession` / `CopilotAcpSession`) | global aliases in `ownership/<alias>.json`; `claudeStandIn` / `codexStandIn` resume a dead alias headless | until any session re-joins the alias |
| Telegram `/claude` `/codex` `/copilot` `/tell` | the global alias | alias lifetime |

Inbound messages add one more rule: `busTarget` routes by sender **name**
(`claude`), not by session, unless the sender passes `--to <conversationId>`;
and the reply goes wherever the footer in `forgeInboundPrompt` talks the model
into sending it — `ask_live_session target: "claude"` (the alias, possibly a
different session) or, with `--reply-in-chat`, "answer here, the sender pulls
it with `forge.sh view`" (nothing arrives in the sender's window). That is how a
Forge reply ends up in an unrelated Claude session.

## The rule this plan installs

1. **A link is per Forge chat and per agent kind.** Chat X has at most one
   Claude, one Codex and one Copilot session. The link is saved on the chat and
   lives exactly as long as the chat does. Decided 2026-10-08: one session per
   kind per chat — two Claudes working in parallel means two Forge chats.
2. **A session belongs to at most one chat.** Otherwise an inbound message from
   it could not be routed. (Enforced in `chatAgentLinks.link()`.)
3. **Every outbound ask uses the chat's link.** No link yet → a new session is
   created and becomes the link. No idle timeout, no global alias.
4. **Every inbound message from an agent carries its sender's session id.** The
   reply goes back to *that* session, delivered by the host — never chosen by
   the model.
5. **The user can always see it.** Every exchange shows in the Forge chat, in
   the linked session's panel (opened on every ask, §2), and on Telegram when
   the chat is bound to Telegram, with a delivery confirmation or a reason.

## Design

### 1. The link record

New owner module `src/agentLinks/chatAgentLinks.ts` (row in `docs/OWNERS.md`).
The link is a field on the persisted conversation (history file,
`HistoryArchive.ts`, written with `writeFileAtomicSync`), so deleting the chat
deletes its links with no second store to keep in step:

```ts
type AgentKind = 'claude' | 'codex' | 'copilot';
interface AgentLink {
  kind: AgentKind;
  sessionId: string;        // Claude session uuid / Codex thread id / Copilot ACP session id
  cwd: string;              // Claude resumes per project dir — must match
  title: string;            // shown in the chat header and on Telegram
  linkedAt: number;
  lastUsedAt: number;
  origin: 'forge-created' | 'first-inbound' | 'user-set';
}
// Conversation.agentLinks?: Partial<Record<AgentKind, AgentLink>>
```

Only `chatAgentLinks.ts` writes `agentLinks`. It keeps an in-memory reverse
index `sessionId → conversationId`, rebuilt from the history file on
activation; it is a cache, never persisted.

### 2. Forge asks an agent (outbound)

One tool, `ask_agent { agent: "claude" | "codex" | "copilot", message,
subject? }`, takes over the CLI targets of `ask_local_agent` and all of
`ask_live_session` / `tell_live_session`. `ask_local_agent` keeps its non-CLI
targets (local models, cloud providers) unchanged. One tool-list change, one
cold re-prefill — accepted (`project_forge_tool_list_cold_prefill`). The model
never names a session. `cliAgentGate` gates `ask_agent` in jobs exactly as it
gates the three tools it replaces.

**Panel on every ask (decided 2026-10-08, Claude and Codex; Copilot has no
panel — headless).** Each `ask_agent` call opens the linked session in its VS
Code panel, or brings it forward if already open. The ask is then written into
that open session, so the user watches it work. How, per phase 0:

- **Claude:** `vscode.commands.executeCommand('claude-vscode.editor.open',
  sessionId, undefined, undefined, undefined, undefined, {programmatic:
  'honor-preferred-location'})` — with `claudeCode.preferredLocation:
  "sidebar"` it lands in the Claude sidebar. **Never** the
  `vscode://anthropic.claude-code/open` URI (always opens in the main editor).
  If the command is missing (extension not installed / older), fall back to
  headless and say so in the chat.
- **Codex:** `vscode.env.openExternal('vscode://openai.chatgpt/local/<threadId>')`.
  It takes focus (owner accepts the cursor moving); no focus restore needed.
- **Copilot:** headless only (no VS Code extension). The header says so.

Setting `agent_links.open_panel: every_ask | never` (default `every_ask`),
Zod-validated in the agent-bus config schema and documented in
`config/config.example.yaml`; `never` falls back to a header button and
headless resume.

Delivery, in order:

- **Session live** (Claude: a live pid in `~/.claude/sessions/` with that
  `sessionId` — the peer-pipe registry `claudePeer.ts` reads; Codex: the owned
  app-server holds the thread, `codexDelivery.ts`; Copilot: the owned ACP
  session) → write into it. Never resume headless beside a live session — two
  writers on one session.
  **Codex ownership caveat:** a Codex panel that opens a thread takes
  `role=owner` of it (phase 0 log). Forge must therefore never resume a
  panel-owned thread in its own app-server; while the panel holds the thread,
  delivery is `codex queue <thread> <msg>` (`codexDelivery.ts`). Phase 2's
  first Codex test confirms `codex queue` reaches a panel-owned thread; if it
  does not, Codex asks fall back to headless `exec resume` with the panel
  closed-state shown, and the result is recorded in this plan.
- **Not live, panel opened by the ask** → wait for it to register live,
  bounded by `agent_links.panel_live_timeout_ms` (default 20000; phase 2
  measures the real time and adjusts the default), then as above. Timeout →
  headless resume is **not** attempted (the panel may still come up and become
  a second writer); the ask fails visibly with "panel did not come up".
- **Not live, no panel** (`never`, or the agent has no panel path) → headless
  resume through the existing adapters: `claude -p … --resume <id>` in
  `link.cwd`; `codex exec resume <id> …` (already in `codexAdapter.ts`);
  Copilot per phase 0(e). `CLAUDE_SPAWN_ENV` keeps Claude runs in the
  extension's history.
- **No link** → new session; the link is saved (`origin: 'forge-created'`)
  **before** the turn runs. Claude and Copilot: Forge generates the uuid and
  passes `--session-id <uuid>`, saving the link before spawning (the session
  cannot exist unlinked). Codex: no such flag — the id is saved the moment the
  first event reports it. A new session is started headless (its first turn),
  then opened in the panel per the setting for later asks.
- **Environment:** every agent Forge spawns gets `CLAUDE_CODE_SESSION_ID`,
  `CODEX_SESSION_ID` and `COPILOT_AGENT_SESSION_ID` removed from its env
  (phase 0 "inherited ids"), in the one place spawn env is built.
- **Linked session is gone** (Claude jsonl deleted, thread missing) → visible
  notice `Claude session "<title>" no longer exists — started a new one`, new
  link, never a silent swap.

**Checkpoint.** A workspace checkpoint is taken before every ask, live or
headless (`WorkspaceCheckpoint.ts`; CLAUDE.md "CLI Agent Delegation" — rollback
is the checkpoint). For a live session the agent may keep editing after Forge's
ask returns; edits after the reply are outside that ask's checkpoint, and the
chat says so.

**Session title.** Forge-created sessions should read `Forge · <chat title>` in
the agent's history. Whether each CLI lets a caller set the title is
**unverified** — phase 0(g). Where it cannot, the first line of the first ask
carries the chat title, which is what the history list shows.

**Stop.** `/stop`, the sidebar stop and Telegram `/stop` abort the ask: the
headless child process (`AbortSignal`, as `ClaudeOwnedSession.send` already
takes) or, for a live session, the peer exchange plus an interrupt where the
agent supports one (phase 0(h)).

### 3. An agent messages Forge (inbound)

- `forge.sh say/send` sends its own identity `sender: {kind, sessionId}` with
  `from`. The id comes from the env variable **of the declared kind only**
  (`claude` → `CLAUDE_CODE_SESSION_ID`, `codex` → `CODEX_SESSION_ID`,
  `copilot` → `COPILOT_AGENT_SESSION_ID`); never "whichever is set". Missing
  → `forge.sh` refuses before posting, naming the variable. Phase 0 verified
  `CODEX_SESSION_ID` in `codex exec`; phase 3 also checks it in a
  panel-opened Codex thread's shell.
- **Senders without an agent identity** (scripts, Relay, a human with curl) are
  not agents: they keep today's routing (`--to`, else the active chat) and the
  plain `**X says:**` prompt. Only an *agent kind* without a session id is
  refused, with a message saying how to fix it.
- Routing an agent message, replacing `busTarget`'s name rule:
  1. The chat linked to the sender session → that chat (activated, as the
     affinity plan does today).
  2. No such chat → the active chat, and the sender becomes its link
     (`origin: 'first-inbound'`) **only if that kind has no link there**.
     If it already has a different session of that kind, a new chat is opened
     for the sender instead.
  - `--to <conversationId>`: honoured only for the sender's own linked chat or
    a chat with no link of that kind (which then links). Otherwise refused,
    naming the linked chat.
  - `--new`: a new chat; the sender's link **moves** to it, and the old chat
    shows `Claude session "<title>" moved to chat "<new>"`.
  - `--reply-in-chat` is removed (the reply is always delivered). `--to-running`,
    `--model`, `--unattended` are unchanged.
- **Which window (decided, phase 0(f)).** Today `forge.sh` posts to
  `endpoint.json`, which follows the **last focused** Forge window. New: every
  Forge window also writes `endpoints/<windowId>.json` (same shape: url,
  token, pid) on activation and deletes it on deactivate. For an agent
  sender, `forge.sh` asks each live endpoint `GET /agent/holds-link?kind=&sessionId=`
  (bounded `curl --connect-timeout 1 --max-time 3`; an unreachable window
  is skipped — `kill -0` cannot see Windows pids from Git Bash or WSL; dead-pid
  files are removed by the next Forge activation) and posts to the one that holds the
  link; none holds it → `endpoint.json` (the focused window, which may link
  it per the rules above). No window-to-window forwarding. If the window that
  holds the link is closed, the link is simply not found in any live window —
  the message goes to the focused window, which already has a link of that
  kind or not, and the normal rules apply (a new chat if it does).
- The inbound exchange is recorded durably (*pending reply*, ledger) before the
  Forge turn starts. A second message from the same sender while the first is
  pending queues as today (`--to-running` steers instead); each has its own
  pending reply, answered in order.
- **The reply is delivered by the host.** When the Forge turn ends, its final
  answer goes to the sender session (live → into it, appearing as an incoming
  message; not live → kept as the exchange verdict, readable with
  `forge.sh view` / `read-verdict`, and the Forge chat says it was not seen
  live). Live delivery exists for Claude (peer pipe) and Codex (`codex queue` into
  the linked thread); Copilot replies take the verdict path (Copilot is
  headless-only, phase 0(e)).
- **The footer goes.** Instead of `_(Agent-bus message. …)_` the model sees one
  line: `From Claude session "<title>". Your final answer is delivered to it automatically.`
  `replyInChat`, `inboundHint` and the `target:` alias hint are deleted.
- **Sender metadata travels as data.** The prompt is stored with
  `sender {kind, sessionId, title}`; sidebar and Telegram render a badge from
  it. `parseForgeInboundPrompt` stays only to read chats saved before this.
  The affinity plan's title rule (`codex: <text>`) stays.
- **Confirmations.** The admission response returns `Forge received your message
  (chat "<title>")` immediately so `say` stays non-blocking; the sidebar shows
  `✓ delivered to Claude · <title>` or the reason it failed.

### 4. Agent to agent

`forge.sh send <name> <to>` relays between agents through the global aliases
today. After this plan, a sender that is linked to chat X resolves `<to>` to
chat X's link of that kind (creating it if absent, per §2). An unlinked sender
cannot address `claude`/`codex`/`copilot` by alias and is told to message Forge
instead. Verdicts and `read-verdict` / `ack-verdict` are unchanged.

### 5. Telegram

Telegram stays bound to Forge **chats** (existing per-conversation bindings).
Agents are reached through the bound chat's links, so the owner never picks a
session on the phone.

The owner receives, for a chat bound to Telegram, each as a **new message**,
never an edit (edits raise no push notification —
`project_forge_telegram_edit_no_notification`); `liveSessionMirror.ts` already
mirrors live-session exchanges and is extended, not duplicated:

- `→ Claude (<title>): <first lines of the ask>` when Forge asks.
- `✓ Claude received it`, or `✗ <reason>` (session gone, CLI not found, auth,
  panel not available).
- `Claude (<title>) says: <reply>` — capped like other remote text; the full
  reply is in the Forge chat. Files only on request (`send-file`).
- An agent writing to Forge on its own: the same `says:` line, then Forge's
  answer, then `✓ delivered to Claude (<title>)`.
- Approvals and questions, through the existing bridges (they fall back to
  `bindingsForConversation`, `d274397`).

The same lines with `Codex` / `Copilot` for those agents.

The owner can send:

- `/claude`, `/codex`, `/copilot <text>` and `/tell` → **the bound chat's
  link**, created if absent. `remote-notify` / `remote-ask` validate the
  sender's session id against the exchange instead of the live alias.
- A plain message → Forge, as today.
- `/stop` → Forge and the ask in flight.
- New `/agents` → this chat's links: kind, title, last used, running or idle.
- `/new` → a new chat with no links; the old chat keeps its own.

Opening a panel on every ask happens on the PC even when the owner is on the
phone; harmless, and it means the session is live when they come back. Only
the lease-holding window sends to Telegram (no duplicates across windows).
Agent-originated turns are not gated on "did a chat start this turn" (the
`d274397` bug class).

### 6. Lifecycle of a link (user-visible)

| Event | What happens to the chat's links |
|---|---|
| Reload / restart / a week later | Unchanged — they live on the saved chat |
| `/newChat` | New chat starts with none; old chat keeps its own |
| `/clearChat` (decided 2026-10-08) | Kept. The header shows them; "Unlink" is one click |
| `/compact` | Kept |
| Chat deleted | Gone with the chat. The sessions themselves are untouched |
| User deletes the session in Claude/Codex/Copilot | Next ask says so and creates a new link |
| User picks another session ("Link to…" in the header, `/link claude`) | Replaced, `origin: 'user-set'`; refused if that session is linked to another chat, naming it |
| Sender uses `forge.sh say --new` | Link moves to the new chat (§3) |
| Unlink while an ask is in flight | The ask finishes; its reply still lands; the link is gone afterwards |

### 7. What is deleted

- Global aliases as a routing target: `aliasRegistry`, `ownership/<alias>.json`
  and `.claim` (deleted on activation), `claudeJoin`/`codexJoin`
  (`forge.sh join`), `claudeStandIn`/`codexStandIn`, `inboundHint`,
  `--reply-in-chat`.
- `CliSessionRegistry`'s 15-minute reuse for CLI agents. The concurrency cap
  (`DEFAULT_MAX_CLI_AGENTS`) stays in some form; it no longer decides *which*
  session.
- `ask_live_session`, `tell_live_session`, and CLI targets of
  `ask_local_agent` (into `ask_agent`).
- `busTarget`'s sender-name rule (§3 replaces it for agents).

Kept: `forge.sh` (by session), steer, `send-file`, `read-verdict` /
`ack-verdict`, the selected CLI chat-model Codex app-server path, parallel work
across kinds and across chats. Copilot linked asks currently use the headless
CLI path; the old alias-owned ACP path was removed with its callers in phase 5.

## Phases

0. **Spike — DONE 2026-10-08** (findings below): (a) own session id,
   (b) headless resume beside a live session, (c) Codex headless resume
   (already in `codexAdapter.ts`), (d) open a specific session in a panel,
   (e) Copilot resume/panel, (f) multi-window routing, (g) session title,
   (h) interrupt.
1. **Link record and owner module.** `src/agentLinks/chatAgentLinks.ts`
   (`link`, `unlink`, `move`, `get`, `findBySession`, reverse index rebuilt
   from history on activation); `Conversation.agentLinks` persisted through
   `HistoryArchive.ts`; header strip in the sidebar (links, "Unlink", "Link
   to…", `/link`). `test/unit/AgentLinkOwnership.test.ts`. Nothing routes
   through links yet; the mesh keeps working unchanged. **No ownership files
   are deleted in this phase** — aliases still route until phase 5.
2. **Outbound `ask_agent`** — replaces `ask_live_session`,
   `tell_live_session` and the CLI targets of `ask_local_agent` **in this
   phase** (one tool-list change, not two): panel-on-ask, live/headless/new/
   gone, env stripping, checkpoint, title, stop, jobs gate (`cliAgentGate.ts`,
   `jobSchema.ts`), lazy group (`lazyToolGroups.ts`: `ask_agent` takes the
   replaced tools' slot), tool-result rendering (`toolResultView.ts`),
   mirror (`liveSessionMirror.ts`), config (`agentBusSchema.ts`,
   `config.example.yaml`). First tasks, before building on them: the Claude
   sidebar placement test and the `codex queue`-into-panel-owned-thread test
   (§2), results written into this plan.
3. **Inbound by session id, host-delivered reply**: `forge.sh` identity by
   declared kind, `endpoints/<windowId>.json` + `/agent/holds-link`,
   pending-reply record, footer removal (`busContent.ts`), sender badge,
   confirmations, `--to`/`--new` rules, `busTarget` replaced for agents.
4. **Agent-to-agent and Telegram**: `send <to>` via links; mirror lines as new
   messages, `/agents`, `/claude` `/codex` `/copilot` `/tell` via the bound
   chat's links (`remoteSessionTellCommands.ts`), notify/ask scoped by session.
5. **Deletions** (§7): the alias layer under `src/agentMesh/` (`ownership.ts`,
   `aliasFifo.ts`, `claudeJoin.ts`, `codexJoin.ts`, `claudeStandIn.ts`,
   `codexStandIn.ts`, and every caller — grep `ownershipPath`,
   `aliasRegistry`), `ownership/*.json` + `.claim` deleted on activation,
   `CliSessionRegistry` reuse, `inboundHint`, `--reply-in-chat`, `join`;
   `CHANGES.md`, `docs/OWNERS.md`, the `forge.sh` usage header, CLAUDE.md
   "Agent mesh direct file delivery".

Each phase: `npm run ci` green; the implementer leaves the change uncommitted
and reports; the supervisor (Claude) reviews, then commits to main. No phase
starts before the previous one is committed. Every new module gets its
`docs/OWNERS.md` row in the phase that creates it; files stay under 500 lines.

## Phase 0 findings (2026-10-08)

Verified on Claude Code 2.1.285 (VS Code extension), Codex extension
`openai.chatgpt` 26.5917 (bundled `codex.exe`), Copilot CLI 1.0.91. Two real
calls were made (one `codex exec`, two `copilot -p`, ~0.34 Copilot credits);
nothing was opened on screen.

| Item | Claude | Codex | Copilot |
|---|---|---|---|
| (a) session knows its own id | **pass** — `CLAUDE_CODE_SESSION_ID` in its shell (this session's own value checked) | **pass** — `CODEX_SESSION_ID` in its shell equals the `session id:` codex printed | **pass** — `COPILOT_AGENT_SESSION_ID` equals the `--resume=` id it printed |
| Forge chooses the id up front | **yes** — `--session-id <uuid>` | no — read from the first event (as today) | **yes** — `--session-id <uuid>` (also for new sessions) |
| (d) open a *specific* session in a panel | **pass** (live, 11:56) — `vscode://anthropic.claude-code/open?session=<id>` opened that session: log `launch_claude … resume: 2a2bffa1…`, title `PHASE0 TEST - safe to delete`. Command `claude-vscode.editor.open(<id>)` does the same from inside VS Code | **pass** (live, 11:56) — `vscode://openai.chatgpt/local/<id>` opened that thread: Codex log `Handling URI path=/local/01a11aba…`, `maybe_resume_success`, panel took `role=owner` of the thread | **fail** — no Copilot VS Code extension installed; headless only (accepted) |
| panel session is live for Forge to write into | **pass** — panel sessions register a peer socket (`CLAUDE_CODE_MESSAGING_SOCKET`), the path `claudePeer.ts` uses | **pass** — `codex queue <session> <msg>` hands a message to the open session (`codexDelivery.ts` already uses it) | n/a |
| (b) headless resume of a running session | `--bg --resume` "starts a copy and says so"; `-p --resume` unverified — the design never does it (live check first) | unverified — same rule | n/a (headless only) |
| (e) resume by id | `--resume <id>` | `exec resume <id>` | `--resume <id>`, and ACP `session/load` (already in `copilotAcpProtocol.ts`) |
| (g) set the session title | **pass** — `-n/--name`; `renameSessionTab` command | **no flag** found on `exec`; sessions do have names (`archive <id or name>`) — first-line fallback until an app-server call is found | **pass** — `-n/--name` |
| (h) stop a running ask | headless: kill child / `ClaudeOwnedSession.interrupt`; panel: **no interrupt path** found | app-server `turn/interrupt` (in `CodexAppServerSession`) | ACP `session/cancel` (in `copilotAcpTurn.ts`) |
| keyboard focus on open | code: `editor.open(id, …, {programmatic: 'pin-to-panel'})` sets `focusInput: false` — built for this; re-revealing an already open tab uses a plain `reveal()`, which may take focus. Live: the URI path is not Forge's path; test from inside Forge in phase 2 | code: `createEditorPanel` uses `preserveFocus ?? false`, and the URI route passes none → **takes focus**. No command opens a thread, so Forge must use the URI and then give focus back to the editor the user was in | n/a |

(f) Multi-window: not a capability question, a design choice. Recommended:
every Forge window registers `endpoints/<window>.json` (alongside the existing
`endpoint.json`), and `forge.sh` asks each live endpoint which one holds the
sender's link before posting; no endpoint holds it → the focused window, which
may link it per §3. No window-to-window forwarding.

**New design rule from (a) — inherited ids.** Session variables leak into child
processes: the Copilot test process, started from a Claude session's shell,
carried that Claude session's `CLAUDE_CODE_SESSION_ID` beside its own
`COPILOT_AGENT_SESSION_ID`. So `forge.sh` must take the id from **the variable
of the kind the sender declares** (`say codex` → `CODEX_SESSION_ID`), never
"whichever variable is set", and refuse when that variable is missing. Forge
strips all three variables from the environment of every agent it spawns, so
a Forge-spawned agent never inherits a foreign id.

**Live focus/placement test (12:01, owner watching).** Both URIs moved the
cursor into the opened session — the owner accepts that. The Claude session
opened in the **main editor**, which the owner does not want: the URI calls
`claude-vscode.primaryEditor.open`, which always targets the editor. Forge must
instead call `claude-vscode.editor.open(sessionId, undefined, undefined,
undefined, undefined, {programmatic: 'honor-preferred-location'})`; with the
owner's `claudeCode.preferredLocation: "sidebar"` the extension then routes to
`activateInSidebar(sessionId)` (code-verified, not yet run — only reachable
from inside VS Code, so it is phase 2's first test). Two consequences:
the Claude sidebar shows **one** session, so a Forge ask replaces what the
owner had there (that session keeps running, reachable from Claude's session
list); and a session already open as an editor tab is revealed there instead
(`sessionAlreadyOpenInPanel`). Codex placement is acceptable as is.
Decided 2026-10-08: the owner accepts a Forge ask switching the Claude
sidebar to the chat's linked session.

**Panel gap for Claude (h).** A Claude session open in a panel cannot be
interrupted by Forge; `/stop` there ends Forge's wait and tells the user the
session may still be working. Acceptable under decision 4.

Result: **0(a) passes for all three agents — no blocker.** Panels: Claude
and Codex open the exact session (verified live), Copilot headless. Focus:
Claude has a non-focusing mode; Codex takes focus and Forge restores it.
The live focus check runs from inside Forge as phase 2's first test.
Test sessions left behind: Claude `2a2bffa1-…` ("PHASE0 TEST - safe to
delete"), Codex `01a11aba-3b34-…`.

## State × lifecycle ledger

| Artifact | Create | Delete | Pause/disable | Crash mid-write | Owner-process death | TTL/expiry |
|---|---|---|---|---|---|---|
| `Conversation.agentLinks[kind]` (history file) | `chatAgentLinks.link()` when a new session reports its id, on first inbound from an unlinked kind, on "Link to…", or on `--new` (move) | with the chat; "Unlink"; replaced on relink, on move, or when the session is found gone | `agent_bus.enabled: false` or CLI agents disabled → kept, unused; `ask_agent` errors naming the setting | `writeFileAtomicSync` — old or new, never torn. Claude/Copilot: link saved before spawn (`--session-id`), so no unlinked session exists. Codex: a crash between the first event and the save leaves an orphan thread; the next ask creates a new session and says so | link is saved before (Claude/Copilot) or at first event (Codex), so the next ask after a window death resumes it | none — never expires; a gone session is detected on use |
| Reverse index `sessionId → conversationId` | built on activation from the history file | dropped on deactivate | not built while the bus is disabled | in memory only — nothing to tear | rebuilt on next activation | none |
| Pending reply (`exchangeId`, sender `{kind, sessionId}`, `conversationId`, `workspace`) under the agent-bus dir | inbound admission, before the Forge turn starts | after the reply is delivered or stored as a verdict | bus disabled → inbound refused, nothing written | temp + rename; a torn file is treated as absent, the answer stays in the chat with a visible "reply not delivered" notice | on next activation in the same workspace and with a known conversation: turn finished → deliver; turn never finished → deliver "Forge restarted before answering"; other windows skip the record | 24 h, then removed with a notice in the known chat; other workspaces/windows leave it untouched |
| Exchange verdict (existing `verdictArtifact`) | reply to a sender that is not live | `ack-verdict` | unchanged | existing atomic write | survives; read on demand | existing mesh retention |
| Remote binding (existing, per chat) | unchanged | unchanged | unchanged | unchanged | lease holder only sends; another window takes over by lease | unchanged |
| Telegram mirror lines (outbox items) | each ask / receipt / reply event | marked delivered | `canDeliver` false → not queued | existing outbox resume | pending items resume on startup | existing outbox policy |
| `endpoints/<windowId>.json` (agent-bus dir) | window activation, temp + rename | window deactivate; files whose pid is dead are removed by any Forge activation | bus disabled → not written, and deleted if present | temp + rename — a torn file never appears; `forge.sh` ignores an unparseable file | stale file stays until the next activation sweeps it; `forge.sh` skips it when its holds-link call fails to connect | none beyond the activation sweep |
| Workspace checkpoint per ask (existing `WorkspaceCheckpoint`) | before every ask, live or headless | existing Keep/Undo | not taken when the ask is refused | existing behaviour | existing behaviour | existing behaviour |
| Legacy `ownership/*.json` and `.claim` files | created only by pre-phase-5 builds | deleted on extension activation; failures are logged and shown as a warning | cleanup runs regardless of bus configuration | deletion is idempotent; remaining files are retried next activation | next activation retries any remaining files | gone after successful cleanup on activation |
| The session itself (Claude jsonl / Codex thread / Copilot session) | the agent's CLI, on first ask | the user, in that tool — Forge never deletes it | not Forge's | not Forge's write | not Forge's process | none; detected missing on next use |

**CI-enforced row:** `agentLinks` writes. `test/unit/AgentLinkOwnership.test.ts`
fails if any file in `src/` other than `chatAgentLinks.ts` assigns
`agentLinks`, asserts deleting a conversation leaves no link in the history
file, and asserts one session is never linked to two chats. A second check
fails the build if any source still references `ownershipPath` or
`aliasRegistry` after phase 5. `LegacyAliasCleanup.test.ts` pins the ownership
file cleanup behavior to this ledger row.

## Acceptance criteria

- [ ] New chat, "ask Claude …" → a new Claude session opens in its panel
      (focus not stolen) and the ask appears in it; the chat header shows its
      title.
- [ ] Same chat after a window reload, and with the clock advanced 7 days in
      the test → "ask Claude again" uses the same `sessionId`, in the same panel.
- [ ] Same checks for Codex; for Copilot where phase 0 shows it possible,
      otherwise headless with the header saying so.
- [ ] Two chats each asking Claude get two different sessions; neither reaches
      the other's. Same for Codex.
- [ ] Claude session A sends `forge.sh say` → the Forge reply arrives in
      session A only, with no tool call from the model; session B, also live,
      receives nothing. A receives `Forge received your message` first. Same
      for a Codex session.
- [ ] Session A linked to a chat in window 1, window 2 focused → the message
      still reaches window 1's chat, or is refused visibly; never window 2.
- [ ] A script sender with no agent identity is routed as today.
- [ ] Inbound prompt text has no `_(Agent-bus message.` footer and no `target:`
      hint; the sidebar shows a sender badge.
- [ ] Linked session deleted → visible notice, new link, no silent swap.
- [ ] Chat linked to Claude A receives from Claude B → B gets its own new chat.
- [ ] `--new` from A moves A's link and notes it in the old chat.
- [ ] `forge.sh send <me> codex` from a session linked to chat X reaches chat
      X's Codex link.
- [ ] Telegram-bound chat: ask, receipt and reply each arrive as a new message
      (unit: `channel.send`, not edit); `/agents` lists the links; `/claude`
      and `/codex` go to the bound chat's links.
- [ ] `/stop` from Telegram cancels the in-flight ask.
- [ ] Crash after inbound admission, before the turn ends → after reload the
      sender gets the answer or "Forge restarted before answering".
- [ ] A job's turn calling `ask_agent` is gated by `jobs.allow_cli_agents`.
- [ ] Claude ask opens the session in the **Claude sidebar** (not the main
      editor) via `claude-vscode.editor.open` + `honor-preferred-location`;
      an already-open editor tab is revealed instead.
- [ ] Every agent Forge spawns has none of `CLAUDE_CODE_SESSION_ID`,
      `CODEX_SESSION_ID`, `COPILOT_AGENT_SESSION_ID` in its env (unit test on
      the spawn env builder).
- [ ] `forge.sh say codex …` with only `CLAUDE_CODE_SESSION_ID` set refuses,
      naming `CODEX_SESSION_ID`; it never sends the Claude id as a Codex id.
- [ ] Two Forge windows: a stale `endpoints/<id>.json` with a dead pid is
      skipped by `forge.sh` and removed on the next activation.
- [ ] Ledger CI test in place and green.
- [ ] No `ownership/*.json` after first activation; `join` and
      `--reply-in-chat` gone from the `forge.sh` usage header.
- [ ] `npm run ci` and `npm run package` pass; live test on the installed VSIX
      with Claude, Codex and Copilot, from the sidebar and from Telegram,
      before tagging.

## Decisions (all settled 2026-10-08)

Claude and Codex fully in scope, Copilot where possible (headless — no panel);
`/clearChat` keeps links; panel opened on every ask; one session per kind per
chat; headless fallback where a panel path fails is acceptable; `--new` moves
the link; edits a live session makes after Forge's ask returns fall outside
that ask's checkpoint (accepted, the chat says so); the Claude sidebar shows
one session, so a Forge ask switching it to the chat's linked session is
accepted; the cursor moving into an opened Codex/Claude session is accepted.

## Review corrections (final pass, 2026-10-08)

- Phase 1 used to delete `ownership/*.json` on activation while phases 1-4
  still route through aliases — that would have broken the mesh for four
  phases. Moved to phase 5.
- §3 still said phase 0(f) "decides" window routing; now states the decided
  `endpoints/<windowId>.json` + `/agent/holds-link` design, with a ledger row.
- §2 said "with `preserveFocus`"; phase 0 showed Claude must use
  `editor.open` + `honor-preferred-location` (sidebar) and Codex takes focus
  (accepted). Rewritten per agent.
- `--session-id` lets Forge save Claude/Copilot links before spawn; ledger
  crash cell updated. Codex keeps save-at-first-event.
- Codex panel takes `role=owner` of a thread; Forge never resumes a
  panel-owned thread in its own app-server, and phase 2 verifies `codex queue`
  reaches it.
- Panel-live wait is bounded by a setting and never falls back to headless
  (two writers); fails visibly instead.
- Env-variable stripping and declared-kind identity added to acceptance.
- Tool replacement happens in phase 2 in one go (one cold re-prefill), with
  the files it touches listed; phase 5 lists the alias-layer files.
- Phase test sessions from phase 0 (Claude `2a2bffa1-…`, Codex
  `01a11aba-3b34-…`) are the owner's to delete; Forge never deletes sessions.
- Phase 5 removed the alias-keyed Copilot ACP owner with its callers. Linked
  Copilot asks currently run headless through the CLI adapter; connecting an
  existing ACP-owned session by chat link remains a follow-up before claiming
  live Copilot parity.
