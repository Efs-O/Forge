# Single-view conversations implementation report

## Commits

- Phase 1 (already committed before this continuation): `fcb8d8f` — Implement single-view conversation UI.
- Phase 2: `e266956` — initial host capacity, queue, waiting marker and bus behavior; `6633210` — unattended chats remain ineligible; `1c63aed` — remote capacity refusal names the busy condition.
- Phase 3: `08d1031` — hidden chat alert tests and alert disposal restoration.
- This report is committed separately after the phase commits.

## CI

Latest successful `npm run ci` after the continuation code commit:

```text
Test Files  319 passed | 5 skipped (324)
Tests       3091 passed | 18 skipped (3109)
bundle-load: module scope OK, activate/deactivate exported, deactivate() clean
```

The run also passed type-check, ESLint, production extension/webview build and `check:bundle`.

## Implemented

- Kept the load-time dedupe in `src/sidebar/sessionPersistence.ts`: when an id exists in both the open memento and history, the open copy wins. This is outside `sessionTypes.ts`, as requested. Regression test: `test/unit/sessionTypes.test.ts`.
- Added least-recently-active auto-archive to create and restore in `ConversationTabs`, through `opArchiveLeastRecent` and the regular close/archive transition. `ConversationTabs` documents that the history archive write precedes session persistence; load-time dedupe handles a crash between them.
- The eviction guard currently rejects streaming turns, active request chains, unattended runs, pending active/queued approvals, pending questions, unattributed pending requests, and local queued prompts. Eviction remains disabled until the webview has sent its first queue report.
- Added approval/question waiting ids to session sync, reports local queued ids to the host, and displays Waiting alongside Running and Queued in Open history rows.
- Agent bus create and restore now use `activate: false`.
- Added `hiddenChatAlerts.ts`, wired it to approval/question and provider turn events, restores decorated event callbacks on disposal, clears alerts on resolution/seen, and opens attributed chats from the notification action. `SidebarProvider.dispose()` disposes it; the provider is disposed by the extension subscription at `src/extension.ts:388`.
- Renamed `webview-ui/styles/tabs.css` to `webview-ui/styles/chat-header.css` and updated `esbuild.config.mjs`.

## Event emission paths (§4)

| Event | Emission path | Conversation id |
|---|---|---|
| Approval requested | `src/sidebar/ToolApprovalService.ts:212`, reached through `src/sidebar/AgentLoop.ts:193` and `src/sidebar/ToolDispatch.ts:312-313` | Yes at the AgentLoop/ToolDispatch call sites (`convId`); the service event field remains optional for other callers. |
| `ask_user` question | `src/sidebar/UserQuestionService.ts:137`, reached through `src/tools/uxTools.ts:229` | `context?.conversationId`, so it may be absent. |
| Generation started | `src/sidebar/ProviderTurn.ts:112,234`; `src/sidebar/CliTurn.ts:132` | Yes (`convId`). `src/sidebar/PromptRun.ts:211` passes no id. |
| Generation finished | `src/sidebar/ProviderTurn.ts:84`; `src/sidebar/CliTurn.ts:194` | Yes (`convId`). `src/sidebar/PromptRun.ts:241` passes no id. |
| Turn failed | `src/sidebar/ProviderTurn.ts:224,273` | Yes (`convId`) at both call sites; the event contract permits absence. |

The `hiddenChatAlerts.ts` references at lines 39, 43 and 51 are decorators forwarding those events, not additional turn emission sites.

## Deviations and remaining gaps

- Closed: the eviction predicate now queries `RemoteRuntime`/`RemoteRequestStore` through an explicit public seam. It fails closed until remote state loads and blocks conversations with a binding or queued remote request.
- Closed: added CI fixtures for every listed eviction signal and the clear-signal LRU case.
- Closed: added unattributed approval, short finish, unattributed finish, and running-turn alert cases.
- Closed: caller-level local create and restore cap tests cover LRU archive success and refusal with no eligible chat. Facade create coverage checks successful creation and the busy exception. Agent bus dispatch tests cover the `say` restore and `say --new` create paths while preserving the active id.
- Closed (Claude, 5c052ee): auto-archive now runs the same agent-loop and checkpoint disposal as a manual close and posts any failure; finish/failure alerts are no longer tracked in `waiting`, so they cannot silence a later approval or question from the same hidden chat.
- Closed (Claude): a chat with undecided Keep/Undo changes (`checkpoints.canUndo`) is not evictable (`undecidedChanges` signal, user decision 2026-09-23).
- Closed (Claude): a workspace handoff whose chat cannot be opened at the cap now completes, keeps the rest of the batch going, leaves the chat unbound and tells the phone why. It used to throw after the claim: the handoff never completed, later handoffs were dropped, and at window startup the transports never started.
- Remote `/new` and first-prompt admission need no change: a thrown busy error is retried by the channel, then acknowledged as a rejection whose text ("Forge: all N open chats are busy.") reaches the chat. Full CI green (320 files / 3102 tests).
- README has no remaining Forge conversation-tab wording to change. Its `README.md:89` “Changelog tab” and `README.md:576` editor-context “tabs” refer to separate VS Code UI concepts, so neither was changed. Screenshots were left untouched.

## Phase 4 entries for merge-time docs

Do not copy these into `CHANGES.md` or `docs/OWNERS.md` in this worktree.

Proposed `CHANGES.md` entry:

> Replaced the conversation tab strip with a single-chat header and a unified history panel. Open chats appear before archived chats with running, waiting, and queued markers. Creating or restoring at capacity archives the least-recently-active eligible chat. Hidden chats raise notifications for approval, question, long-running completion, and failure events.

Proposed `docs/OWNERS.md` entry:

> | Hidden conversation notifications | `src/sidebar/hiddenChatAlerts.ts` |

Also remove any existing `TabStrip` ownership row if present when Claude updates the ownership map.

## State × lifecycle ledger

| Artifact | Create | Delete | Pause/disable | Crash mid-write | Owner-process death | TTL/expiry |
|---|---|---|---|---|---|---|
| Remote eviction query seam (derived from remote store) | Query becomes available after `RemoteRequestStore.load()` | No independent state to delete | Unavailable query blocks eviction | The store's atomic state write governs the result | Runtime restart makes query unavailable until reload, so eviction fails closed | No independent expiry; queued request state follows the remote store |
| Eviction fixture matrix (test-only) | Test source added | Remove test source | Not applicable | Not applicable | Not applicable | Not applicable |
