# Single-view conversations implementation report

## Commits

- Phase 1 (already committed before this continuation): `fcb8d8f` — Implement single-view conversation UI.
- Phase 2: `e266956` — initial host capacity, queue, waiting marker and bus behavior; `6633210` — unattended chats remain ineligible; `1c63aed` — remote capacity refusal names the busy condition.
- Phase 3: `08d1031` — hidden chat alert tests and alert disposal restoration.
- This report is committed separately after the phase commits.

## CI

Final successful `npm run ci` before the latest Phase 2 follow-up commit:

```text
Test Files  319 passed | 5 skipped (324)
Tests       3076 passed | 18 skipped (3094)
bundle-load: module scope OK, activate/deactivate exported, deactivate() clean
```

The run also completed `type-check`, ESLint, `npm run build` (extension and webview), and `check:bundle`. Earlier runs intermittently failed unrelated Telegram/remote timing tests; the final complete run was green.

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

- The `ConversationTabs` eligibility predicate has no remote-binding or remote-intake-queue query. `RemoteRuntime` owns its `RemoteRequestStore` privately (`src/remote/RemoteRuntime.ts:51`), while `ForgeHostFacade` exposes neither binding state nor pending remote queue ids. As a result, an otherwise idle bound chat or chat with a remote prompt waiting outside a request chain may still be selected for auto-archive. This needs a small remote-to-sidebar query seam.
- The plan's CI-enforced fixture matrix for each individual evictable signal, and caller-level cap tests for remote `/new`, first-prompt admission and workspace handoff, were not added. Existing caller paths share `ConversationTabs.create/restore`, but those caller contracts are not independently asserted here. A dedicated bus test for active-conversation stability is also absent.
- The alert tests cover deduplication/resolution, hidden-view behavior, long finish, unattributed failure/question, seen clearing and Open chat. They do not individually exercise every §4 event/policy permutation (notably unattributed approval and short-turn suppression).
- README has no remaining Forge conversation-tab wording to change. Its `README.md:89` “Changelog tab” and `README.md:576` editor-context “tabs” refer to separate VS Code UI concepts, so neither was changed. Screenshots were left untouched.

## Phase 4 entries for merge-time docs

Do not copy these into `CHANGES.md` or `docs/OWNERS.md` in this worktree.

Proposed `CHANGES.md` entry:

> Replaced the conversation tab strip with a single-chat header and a unified history panel. Open chats appear before archived chats with running, waiting, and queued markers. Creating or restoring at capacity archives the least-recently-active eligible chat. Hidden chats raise notifications for approval, question, long-running completion, and failure events.

Proposed `docs/OWNERS.md` entry:

> | Hidden conversation notifications | `src/sidebar/hiddenChatAlerts.ts` |

Also remove any existing `TabStrip` ownership row if present when Claude updates the ownership map.
