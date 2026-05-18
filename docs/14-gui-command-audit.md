# GUI Command Audit

Date: 2026-05-17

## Scope

This audit answers four questions:

1. Which GUI-exposed Forge commands exist today?
2. Are they actually connected to the host/prompt/backend pipeline?
3. Are any commands missing from the current GUI or command surfaces?
4. Which additional command patterns are worth borrowing from Codex or Claude Code without violating Forge's local-first product constraints?

## Sources Inspected

Forge code:

- `package.json`
- `src/extension.ts`
- `src/vscode/nativeCommands.ts`
- `src/vscode/codeActions.ts`
- `src/sidebar/SidebarProvider.ts`
- `src/sidebar/messageBridge.ts`
- `webview-ui/src/App.tsx`
- `webview-ui/src/slashCommands.ts`
- `webview-ui/src/components/Header.tsx`
- `webview-ui/src/components/InputRow.tsx`
- `webview-ui/src/components/CheckpointBar.tsx`

External comparison references checked on 2026-05-17:

- OpenAI Codex CLI docs: `https://developers.openai.com/codex/cli`
- OpenAI Codex product update: `https://openai.com/index/introducing-upgrades-to-codex/`
- Claude Code VS Code docs: `https://code.claude.com/docs/en/vs-code`
- Claude Code commands docs: `https://code.claude.com/docs/en/commands`
- Claude Code skills/slash docs: `https://code.claude.com/docs/en/slash-commands`

## Executive Summary

The current Forge GUI/command surface is mostly wired correctly.

- All 27 contributed VS Code commands in `package.json` are registered.
- All 7 sidebar slash commands are recognized by the typed webview bridge and handled on the host side.
- There are no obvious dead commands declared in the manifest but missing in code.
- The main gaps are product gaps, not broken plumbing.

Main findings:

1. Most "editor helper" commands are connected only to prompt prefill, not to immediate execution.
2. The sidebar model dropdown changes the selected model but does not hot-swap immediately; the command-palette model picker does.
3. Sidebar `/restart` is mislabeled: today it calls `backend.start()`, which can become a no-op if the active model is already loaded, so it does not guarantee a real restart.
4. Several useful sidebar actions are not exposed as first-class VS Code commands: clear chat, unload model, and reopen/restore conversation.
5. Forge is missing a few high-value command families seen in Codex/Claude-style workflows: context compaction, explicit review command, approval-mode control, and user-defined project commands/skills.

## Inventory

### A. VS Code contributed commands

Forge contributes 27 commands in `package.json`.

#### Backend / setup commands

| Command | Connected? | Path | Notes |
| --- | --- | --- | --- |
| `forge.openSidebar` | Yes | `extension.ts` -> VS Code view command | Pure UI open/focus |
| `forge.startBackend` | Yes | `nativeCommands.ts` -> `backend.start()` | Real backend action |
| `forge.stopBackend` | Yes | `nativeCommands.ts` -> `backend.stop()` | Real backend action |
| `forge.restartBackend` | Yes | `nativeCommands.ts` -> `backend.stop()` then `backend.start()` | Real restart |
| `forge.showBackendConsole` | Yes | `extension.ts` -> `backend.showConsole()` | Console/log surface |
| `forge.openConfig` | Yes | `nativeCommands.ts` | Opens config file only |
| `forge.validateConfig` | Yes | `nativeCommands.ts` -> `loadConfig(...)` | Validation only |
| `forge.pickModel` | Yes | `nativeCommands.ts` -> `backend.hotSwap(...)` | Immediate model switch |
| `forge.pickGgufModelFile` | Yes | `nativeCommands.ts` | Assisted config edit only |
| `forge.setSearchApiKey` | Yes | `extension.ts` -> `SecretStorage` | Not model pipeline |
| `forge.setupWizard` | Yes | `extension.ts` -> `runFirstRunWizard(...)` | Setup only |

#### Prompt/pipeline entry commands

| Command | Connected? | Path | Notes |
| --- | --- | --- | --- |
| `forge.explainSelection` | Yes | `nativeCommands.ts` -> `sidebar.prefillInput(...)` | Prefill only, user must still send |
| `forge.reviewSelection` | Yes | Same | Prefill only |
| `forge.generateTestsForSelection` | Yes | Same | Prefill only |
| `forge.refactorSelection` | Yes | Same | Prefill only |
| `forge.useCurrentFile` | Yes | Same | Context attach only |
| `forge.useSelection` | Yes | Same | Context attach only |
| `forge.useOpenTabs` | Yes | Same | Context attach only |
| `forge.pickContextFiles` | Yes | Same | Context attach only |
| `forge.explainDiagnostic` | Yes | `nativeCommands.ts` -> `prefillDiagnostic(...)` | Prefill only |
| `forge.fixDiagnostic` | Yes | Same | Prefill only |
| `forge.fixFileDiagnostics` | Yes | Same | Prefill only |
| `forge.draftPlanScratch` | Yes | `nativeCommands.ts` -> `sidebar.runPromptToMarkdown(...)` | Immediate LLM run |
| `forge.draftReviewScratch` | Yes | Same | Immediate LLM run |

#### Conversation/checkpoint commands

| Command | Connected? | Path | Notes |
| --- | --- | --- | --- |
| `forge.newChat` | Yes | `extension.ts` -> `sidebar.newConversation()` | Real UI state action |
| `forge.undo` | Yes | `extension.ts` -> `sidebar.undo()` | Real checkpoint action |
| `forge.keep` | Yes | `extension.ts` -> `sidebar.keep()` | Real checkpoint action |

### B. Sidebar slash commands

Forge defines 7 slash commands in `webview-ui/src/slashCommands.ts`, mirrors them in `src/sidebar/messageBridge.ts`, and handles them in `SidebarProvider.handleSlashCommand(...)`.

| Slash command | Connected? | Host behavior | Notes |
| --- | --- | --- | --- |
| `/unload` | Yes | `backend.stop()` | Good fit for local-first |
| `/restart` | Partly | `backend.start()` | Misnamed; not guaranteed restart |
| `/new` | Yes | `newConversation()` | Good |
| `/clear` | Yes | `clearActiveMessages()` | Sidebar-only, not palette command |
| `/undo` | Yes | `undo()` | Good |
| `/keep` | Yes | `keep()` | Good |
| `/reload` | Yes | `workbench.action.reloadWindow` | Sidebar-only, not palette command |

### C. Other GUI entry points

These are also wired:

- Editor context menu entries for selection/context helpers in `package.json`
- Terminal context menu entries for `forge.showBackendConsole` and `forge.openSidebar`
- Quick Fix code actions for `forge.explainDiagnostic` and `forge.fixDiagnostic` in `src/vscode/codeActions.ts`
- Checkpoint bar buttons in the webview for `undo` and `keep`
- Header model dropdown in the webview for `switchModel`

## Connectivity Verdict

## 1. No dead manifest commands found

I found no case where a contributed `forge.*` command exists in `package.json` without a corresponding `registerCommand(...)` call.

Verdict: good.

## 2. The main prompt pipeline is connected

The actual end-to-end generation path is:

- webview `send`
- `SidebarProvider.handleSend(...)`
- backend readiness / hot swap
- request assembly
- streamed completion
- optional tool dispatch
- checkpoint commit

This is the real pipeline. Commands that truly hit it today are:

- normal chat send from the sidebar
- `forge.draftPlanScratch`
- `forge.draftReviewScratch`

Verdict: good, but narrow.

## 3. Many "AI commands" are only prompt-prefill helpers

This is the biggest behavioral distinction in the current UX.

Commands like:

- `forge.explainSelection`
- `forge.reviewSelection`
- `forge.generateTestsForSelection`
- `forge.refactorSelection`
- diagnostic/context commands

do not execute a turn. They only push prepared text into the sidebar input via `sidebar.prefillInput(...)`.

This is wired, but it is a weaker connection than users may assume from the command names.

Verdict: connected, but indirect.

Implication for eval:

- Forge currently behaves more like "prompt macro insertion" than "run a workflow command" for many GUI actions.
- That is functional, but it is behind Codex/Claude-style expectations where commands often execute immediately.

## 4. Model switching is inconsistent across GUI surfaces

There are two model-switch paths:

- `forge.pickModel` in `nativeCommands.ts` performs immediate `backend.hotSwap(...)`
- the sidebar dropdown sends `switchModel`, which only updates `config.active_model` in `SidebarProvider`; the actual swap happens later on the next send if the loaded model differs

Verdict: connected, but inconsistent.

Implication:

- command palette says "switch now"
- sidebar says "switch later"

That mismatch will be visible to users when backend memory/load behavior matters.

## 5. Sidebar `/restart` is not a real restart

This is the one concrete wiring bug/mislabel.

Current flow:

- `/restart` -> `runSlashCommand`
- `SidebarProvider.handleSlashCommand('restartBackend')`
- calls `backend.start()`
- both `DirectBackend.start()` and `BridgeBackend.start()` delegate to `hotSwap(active_model)`
- `hotSwap(...)` returns early if that model is already active and ready

Result:

- from the sidebar, `/restart` can silently behave like "ensure started" instead of "stop and restart"
- from the command palette, `forge.restartBackend` does a real stop/start cycle

Verdict: command exists, but semantics are wrong.

## Missing Commands / Missing Surfaces

These are the gaps that matter most.

## 1. Missing first-class commands for sidebar-only actions

Useful actions exist only as slash commands, not as VS Code commands:

- clear active chat
- unload current model
- reload window from Forge

Why this matters:

- users cannot bind them to shortcuts cleanly
- they do not appear in the command palette
- they are less discoverable than the existing `forge.*` command family

Recommendation:

- add `forge.clearChat`
- add `forge.unloadModel`
- skip `forge.reloadWindow` unless you want parity for completeness

## 2. Missing conversation restoration commands

The sidebar supports:

- switch conversation
- close conversation
- restore archived conversation

but those actions are only available through the webview session UI. There is no command-palette equivalent such as:

- reopen last closed conversation
- restore from history
- switch to next/previous conversation

Recommendation:

- add at least `forge.reopenLastConversation`
- optionally add next/previous conversation navigation commands

## 3. Missing "run now" equivalents for prefill-only helpers

Current helpers are safe, but they add a manual extra step.

High-value additions:

- `forge.runReviewSelection`
- `forge.runExplainSelection`
- `forge.runFixDiagnostic`

These would:

- prefill context
- immediately submit the request

Recommendation:

- add a second tier of explicit run commands, rather than changing current commands silently

## 4. Missing explicit review command in the sidebar slash set

Given Forge's positioning as a coding companion, a built-in `/review` command is a notable omission.

Today the closest equivalents are:

- `forge.reviewSelection` from editor context
- `forge.draftReviewScratch` from command palette

There is no direct in-chat slash command for "review current diff/selection/file/workspace".

Recommendation:

- add `/review`
- scope it clearly: active selection if present, else current file, else ask for target

## 5. Missing context-compaction / conversation-hygiene command

Codex and Claude both emphasize in-session command control for context management.

Forge currently shows token budget, but there is no command for:

- summarizing the current thread
- compacting context
- carrying forward pinned instructions while dropping transcript bulk

Recommendation:

- add `/compact` or `/summarize-thread`

This fits Forge well because local models are especially sensitive to context-window pressure.

## 6. Missing approval/permission mode controls

Codex exposes approval modes. Claude exposes permission/config patterns. Forge already has tool confirmation for write/delete/terminal/git actions, but there is no explicit user control surface for the approval policy.

Potential commands:

- `/approvals`
- `/safe-mode`
- `/auto-edit`

This does not require cloud behavior. It is purely local UX and aligns with Forge's checkpoint/confirmation model.

Recommendation:

- add one simple mode toggle before adding more tools

## 7. Missing user-defined command/skill system

Claude's current command/skills model is strong: project-local reusable commands and procedures are first-class. Codex also leans heavily on project instructions and workflow shortcuts.

Forge has:

- templates
- AGENTS.md / project instructions

but no user-extensible command layer in the GUI.

Recommendation:

- add project-local custom prompt commands, for example `.forge/commands/*.md`
- keep them prompt-only at first
- do not add arbitrary executable command blobs

This would give Forge a strong local-only differentiator without violating the "strict schema" rule.

## Comparison Against Codex / Claude Code

These are the command ideas worth copying, filtered through Forge's design constraints.

## Worth copying soon

1. Context compaction command
2. Explicit review command
3. Approval-mode toggle
4. Reopen/restore conversation command
5. Custom project commands/skills
6. Immediate-run variants of current prefill helpers

## Worth copying later

1. Better session navigation commands
2. More discoverable model/reasoning controls
3. A command to inspect or summarize active tool permissions

## Not recommended for Forge's core wedge

These exist in broader Codex/Claude ecosystems but are not good defaults for Forge:

1. Cloud task delegation
2. Hosted login/account commands
3. GitHub-review cloud workflows
4. Anything that assumes non-local execution as the primary path

Forge should stay local-first and offline-biased.

## Priority Recommendations

## P0

1. Fix sidebar `/restart` so it performs a real stop/start cycle.
2. Add `forge.clearChat` and `forge.unloadModel`.
3. Document which commands are prefill-only versus immediate execution.

## P1

1. Add `/review`.
2. Add `/compact`.
3. Add one explicit approval-mode command.
4. Add one "run now" command for the most common review flow.

## P2

1. Add custom project command support.
2. Add conversation restore/reopen commands.
3. Add next/previous conversation navigation commands.

## Bottom Line

Forge's current GUI commands are mostly connected correctly. This is not a plumbing-failure story.

The real issues are:

- command semantics are uneven across surfaces
- too many "AI commands" are only prompt insertion helpers
- a few high-value workflow commands are missing

If you want Forge to feel closer to Codex or Claude Code, the next step is not "add dozens more commands." The next step is:

1. fix the inconsistent ones
2. promote the most important helpers from prefill to executable workflows
3. add a small, opinionated set of power-user commands around review, context, permissions, and custom project procedures
