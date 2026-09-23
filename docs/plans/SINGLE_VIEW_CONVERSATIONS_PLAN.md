# Single-view conversations: one chat on screen, the rest in history

Agreed with the user on 2026-09-23. Forge drops the tab strip. One conversation
is visible, and every other chat, open or archived, is reached through the
history list, the way Claude Code does it.

## 1. Why

- **"Active" gets one meaning.** Today a chat can be the selected tab while the
  sidebar shows something else, or be one of twelve chips nobody can read.
  Agents and remote surfaces that act on "the active chat" have to work out
  which one that is. After this change, active means on screen.
- **Room.** Twelve chips in a sidebar-width strip scroll sideways
  (`TabStrip.tsx` carries its own scroll arrows for this).
- **One place to find a chat.** Open tabs and archived history are two lists
  today (`TabStrip` and `HistoryList`), with two sets of actions.

## 2. What the user sees

- **Header row.** It replaces the strip: the current chat's title, a New
  button and the history (clock) button. There is no running/waiting badge.
  The user ruled that out: the markers inside history are enough.
- **History panel.** It keeps `HistoryList`'s panel, rename and delete, and
  gains a top section, **Open**, listing the host's open conversations
  (`sidebar.conversations`), most recently active first. Archived chats follow
  as today. Each Open row shows one marker:
  - **running**: a turn is streaming (the spinner `TabStrip.tsx:170-190` shows
    today);
  - **waiting**: a tool approval or an `ask_user` question is pending in that
    chat;
  - **queued**: a prompt is queued (today's `queuedIds`).
  An Open row also has Close, which does what closing a tab does today.
- **Alerts** (§4). A VS Code notification for a chat that is not on screen.

## 3. Host model: unchanged, plus one transition

The host keeps the split it has: `sidebar.conversations` (open, capped at
`MAX_CONVERSATIONS = 12`, `sessionTypes.ts:27`) and `sidebar.history`
(archived, `HistoryArchive.ts`). Switch, close, restore and delete stay in
`ConversationOps` and `ConversationTabs`. The webview stops rendering the open
set as chips and renders it as the Open section instead.

**New transition: auto-archive at the cap.** With tabs, the user saw twelve
chips and closed one. With no strip, "at cap" would be a silent wall behind
the New button and behind every history restore. The rule lives in
`ConversationOps`, next to the two `atCap` returns (`ConversationOps.ts:40`,
`:201`), so every caller inherits it:

- local New, and restore from history (`ConversationTabs.create` and
  `.restore`);
- the host facade's create, which today throws at cap
  (`ForgeHostFacade.ts:208`), and therefore remote `/new`
  (`RemoteCommandHandler.ts:274`), first-prompt admission
  (`RemotePromptAdmission.ts:59`) and workspace handoff
  (`RemoteWorkspaceHandoff.ts:89`, including its restore-then-create fallback
  at `:115`);
- the agent bus (`agentMessagingSetup.ts:61-64`).

When a create or restore would exceed the cap, the least recently active
**evictable** open conversation (by `updatedAt`) is archived through the
existing close path. If nothing is evictable, the existing at-cap refusal
stands, and its message names the reason ("all 12 open chats are busy").

**Evictable** means none of the following holds. Each signal gets its own unit
test, and the fixture list is the CI-enforced row in §7:

| Signal | Source today |
|---|---|
| Streaming turn | the streaming set the webview already receives |
| Active request chain | `RequestChainLifecycle` (`RemoteController.ts:470` reads it) |
| Unattended marker (job run) | `UnattendedConversationRegistry.has` (`unattendedConversations.ts`) |
| Pending approval, active **or queued** | `ToolApprovalService`: its active item plus its queue (`:47`); `pending()` returns only the active one (`:66`), so add an accessor for all of them |
| Pending `ask_user` question | `UserQuestionService` |
| Queued prompt | host remote queue, **and** the webview's local queue (`App.tsx:284`), which the host cannot see today: the webview posts its queued conversation ids to the host whenever they change (a new bridge message) |
| Bound remote chat | remote bindings (`remoteBindingQueries.ts`). A binding is not "busy", but archiving a bound chat would leave Telegram pointed at an archived conversation. Bound chats are ineligible, full stop |

**Unattributed requests.** Approval and question events carry an optional
`conversationId` (`ToolApprovalService.ts:8`, `UserQuestionService.ts:8`).
While any pending request has no conversation id, auto-archive evicts nothing,
because it cannot prove the request belongs elsewhere. Phase 2 greps every
emission path and adds the id where the caller has it.

**The bus stops moving the view.** Today `forge.sh say --new` creates the chat
with `activate: true`, and an ordinary `say` restores the sender's chat with
`activate: true` whenever it is not the active one (`agentMessagingSetup.ts:61-64`).
With tabs that was a chip changing colour. With one view it yanks the screen
away from the user on every agent message. Both paths change to
`activate: false`. The bus finds its chat by sender (`busTarget.ts`), and
`facade.send` takes a conversation id, so it does not need the view. Phase 2
verifies that `send` works on a chat that is not active.

## 4. Alerts

A new module, `src/sidebar/hiddenChatAlerts.ts`, subscribes to events that
already exist. It raises no events of its own.

| Event | Source | Alert when the chat is not on screen |
|---|---|---|
| Tool approval pending | `ToolApprovalService` request event (what `RemoteApprovalBridge` subscribes to) | always |
| `ask_user` pending | `UserQuestionService` event (what `RemoteQuestionBridge` subscribes to) | always |
| Turn finished | `onGenerationStarted` / `onGenerationFinished` (`providerEvents.ts`) | only if the turn ran 60 s or longer |
| Turn failed | `onTurnFailed` (`providerEvents.ts`) | always |
| Turn running | none | never |

"Not on screen" means the conversation is not the active one, **or** the Forge
view is not visible (`webviewView.visible`). When the view is hidden and the
chat is the active one, the alert still fires, and Open chat only reveals the
view.

**Missing conversation id.** Every one of these events allows it to be absent
(`providerEvents.ts:9`, `:27`; `ToolApprovalService.ts:8`;
`UserQuestionService.ts:8`). The policy:
- an unattributed approval, question or failure still alerts, without the Open
  chat button, and says Forge is waiting (or failed) without naming a chat;
- an unattributed "finished" does not alert, because it cannot know the chat
  was hidden.
Phase 3 lists every emission path in the PR description, with whether it
passes an id.

Each attributed alert has an **Open chat** button. It reveals the Forge view
and switches to that conversation, which makes it the active one.

VS Code notifications cannot be updated or withdrawn once shown. So the module
tracks at most one "waiting" alert per chat and raises no second one while
that entry exists. The entry is cleared by either of two transitions:
- **resolve**: the request is answered or cancelled, from anywhere, including
  Telegram;
- **seen**: the chat comes on screen.
A toast still on screen after its entry is cleared stays harmless: Open chat
just opens the chat.

**No replay.** The services do not replay pending requests to a new subscriber
(`ToolApprovalService.ts:61`, `UserQuestionService.ts:73`), and a pending gate
does not survive an extension-host restart anyway. So after a reload there is
nothing to re-raise, and the module starts empty.

The 60 s threshold is a named constant, not a setting. It separates a quick
background reply from a run the user walked away from. It is not a
user-configurable parameter, so the no-hardcoded-fallback rule does not apply.

## 5. What goes away

- `TabStrip.tsx` and its CSS. Keyboard tab navigation goes with it; the history
  panel keeps its own keyboard handling.
- `SessionTabMeta` stays if the Open section can reuse it. Otherwise it merges
  into `SessionHistoryMeta` with an `open` flag. Pick one; do not keep both
  shapes for one list.
- Any "switch tab" wording in help text, docs and README screenshots.

## 6. Phases

**Phase 1 — webview.** Header row, the Open section and removal of
`TabStrip`. `HistoryList` today omits open chats on purpose, because the strip
listed them (`HistoryList.tsx:254`); that goes. The host posts what it posts
today, so Phase 1 shows the running and queued markers only. Tests cover the
whole mixed panel: Open before archived, Open ordered by activity, Close on an
Open row, and both markers.

**Phase 2 — host state and the bus.**
- The waiting marker: the host posts the conversation ids with a pending
  approval (active or queued) or question, next to the streaming ids.
- The webview-to-host queued-ids message.
- Auto-archive in `ConversationOps`, with tests for:
  - each evictable signal in §3's table;
  - an unattributed pending request blocking eviction;
  - the all-busy refusal;
  - restore at cap.
- Caller-level tests at cap for remote `/new`, first-prompt admission and
  workspace handoff.
- Bus `activate: false` on both paths, with a test that the active chat does
  not change on `say` and `say --new`.

**Phase 3 — alerts.** `hiddenChatAlerts.ts`, wired in the sidebar setup, with
its disposal in `context.subscriptions`. Unit tests with fake events:
- each row of the §4 table;
- the visibility rule, including "view hidden, chat active";
- the unattributed policy;
- one pending alert per chat;
- both clear transitions (resolve and seen);
- Open chat switching the active conversation.

**Phase 4 — docs.** OWNERS rows for the new module (and `TabStrip` removed),
CHANGES and README. In this run these go to Claude at merge time, because
another agent is editing `CHANGES.md` and `docs/OWNERS.md` on main.

## 7. State × lifecycle ledger

| Artifact | Create | Delete | Pause/disable | Crash mid-write | Owner-process death | TTL/expiry |
|---|---|---|---|---|---|---|
| Open conversation (`sidebar.conversations` entry, existing) | New chat, restore from history, remote arrival, bus `--new` | Close, delete, and now **auto-archive at cap** (§3), which moves it to history and never deletes it | No toggle. Auto-archive skips every signal in §3's table, so live work is never archived under itself | Auto-archive is two writes: the history archive (`writeFileAtomicSync`) and the session persist. Phase 2 reads the close path and states the order in code comments. Whichever order it is, a crash between the writes can leave one id both open and archived. Load must resolve that: **the open copy wins and the history duplicate is dropped**. Phase 2 checks whether load already does this and adds a test either way | Same as crash; a turn running at the time is lost exactly as today | None; it stays open until closed, deleted or auto-archived |
| History entry (`HistoryArchive`, existing) | Close and auto-archive | Delete from the history panel; dropped at load when the same id is open (row above) | No toggle | `writeFileAtomicSync`; an unparsable file is renamed aside (`HistoryArchive.ts:52`) | Same as crash | None |
| Webview queued-ids report (in memory, host side) | The webview posts on every change to its local queue | Replaced by the next report; cleared when the webview is disposed | Not applicable | Not durable | Lost with the host; the webview re-posts on reconnect before the host may evict anything | Lives until the next report |
| Tracked "waiting" alert (in memory) | Approval or question event for a chat not on screen | Two transitions: **resolve** (answered or cancelled from anywhere) and **seen** (the chat comes on screen). Also cleared when the chat is deleted | Not persisted | Not durable | Dies with the extension host, as do the pending gates it reports; nothing is replayed (§4) | Lives until resolve or seen |

The two in-memory rows are listed because their cells are the easy ones to get
wrong. A tracked alert that is never cleared silences that chat's alerts for
good. A missing queued-ids report lets auto-archive evict a chat with a prompt
waiting in the webview. So before the first report arrives, the host treats
every open chat as possibly queued and evicts nothing.

**CI-enforced row:** a unit test whose fixture list is every signal in §3's
evictable table, asserting that each one alone blocks eviction. A later change
that adds a new kind of busy must add it to the predicate and to the fixture.
Otherwise the review sees an evictable signal with no test row.

## 8. Acceptance criteria

- [ ] No tab strip. The header shows the current chat's title, New and History.
- [ ] History lists open chats first, ordered by activity, each with a running,
      waiting or queued marker, then archived chats.
- [ ] A hidden chat that asks for approval or `ask_user` raises one
      notification. Open chat reveals the view and switches to it. With the
      view hidden and the chat active, it only reveals the view.
- [ ] A hidden chat whose turn ran 60 s or longer raises a notification when it
      finishes; a shorter one does not. A hidden failed turn always does.
- [ ] Unattributed approvals, questions and failures alert without Open chat;
      an unattributed finish does not alert.
- [ ] Answering an approval from Telegram clears the tracked alert, so the next
      request in that chat alerts again.
- [ ] Creating or restoring a 13th chat archives the least recently active
      evictable chat. Every signal in §3's table blocks eviction on its own. With
      nothing evictable, the refusal says why.
- [ ] Remote `/new`, first-prompt admission and workspace handoff at the cap
      follow the same rule, and none of them throws.
- [ ] Neither `forge.sh say` nor `forge.sh say --new` changes which chat is on
      screen, and both still deliver.
- [ ] One id both open and archived at load keeps the open copy only.
- [ ] `npm run ci` green; no file over 500 lines.
