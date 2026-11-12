# OWNERS.md — Single Point of Truth Map

These are the canonical owners for each concern. Do not duplicate logic across
modules — extend the listed file or split it. Grep before adding any new
constant, type, or function; if you find yourself about to write logic that
overlaps with an existing owner, extend the owner instead.

## Sidebar / UI

| Concern                                              | Owner                                    |
| ---------------------------------------------------- | ---------------------------------------- |
| Extension manifest + contributions                   | `package.json`                           |
| Activation / deactivation sequencing                 | `src/extension.ts`                       |
| Webview lifecycle + message bridge entry             | `src/sidebar/SidebarProvider.ts`         |
| Webview message routing                              | `src/sidebar/webviewMessageRouter.ts`    |
| Outbound webview payloads + status metrics           | `src/sidebar/sidebarPayloads.ts`         |
| Transcript view setting parse + validation           | `src/sidebar/activityViewSetting.ts`     |
| Active workspace root + folder-change watch          | `src/sidebar/workspaceInfo.ts`           |
| Webview crash/diagnostic relay to host log           | `src/sidebar/webviewDiagnostics.ts`      |
| Auto vs manual compaction resume policy              | `src/sidebar/compactionPolicy.ts`        |
| Generation-event session timing                      | `src/sidebar/sessionTimerWiring.ts`      |
| Pure transcript/usage mutations                      | `src/sidebar/transcriptMutations.ts`     |
| Sidebar transcript activity row folding               | `webview-ui/src/activityRows.ts`          |
| Sidebar message timestamp formatting                  | `webview-ui/src/messageTimestamp.ts`       |
| Count-up seconds for in-flight labels (hook)         | `webview-ui/src/useSecondsSince.ts` |
| Tool calls still being written (live progress rows)  | `webview-ui/src/pendingToolCalls.ts` (row: `components/PendingToolCallRow.tsx`; host message: `src/sidebar/toolCallProgress.ts`) |
| Sidebar grouped activity view (step runs → groups, recovered failures, long-group gaps) | `webview-ui/src/activityGroups.ts` |
| Sidebar open/closed and folded-tail choices in webview memory | `webview-ui/src/disclosureState.ts` |
| Sidebar transcript follow-the-bottom decision         | `webview-ui/src/scrollFollow.ts`          |
| Sessions panel Open-row order held while the panel is open | `webview-ui/src/openItemOrder.ts` |
| Compact activity step row component (the call row)   | `webview-ui/src/components/ActivityRow.tsx` |
| Folding repeated result lines before display         | `webview-ui/src/toolResultLines.ts`       |
| Images a tool call produced (row + group strip data) | `webview-ui/src/toolImages.ts` (thumbnails, strip, placeholder: `components/ToolThumbnails.tsx`) |
| Grouped activity row component                       | `webview-ui/src/components/ActivityGroup.tsx` |
| Sidebar host->webview event contract                 | `src/sidebar/providerEvents.ts`          |
| Sidebar collaborator construction                    | `src/sidebar/sidebarWiring.ts`           |
| Sidebar inbox and elapsed-time tell composition | `src/sidebar/midTurnTellWiring.ts` |
| Conversation eviction gate (signals, refusal labels) | `src/sidebar/evictionGate.ts`            |
| Chat inactivity timestamp, Keep open and nearest-deadline scheduler | `src/sidebar/ConversationRetentionScheduler.ts` |
| Final eligibility revalidation and persistence-checked idle archive | `src/sidebar/ConversationTabRetention.ts` |
| Persisted retention fields and compatibility mapping | `src/sidebar/conversationRetentionState.ts` |
| Retention scheduler and tab construction seam | `src/sidebar/conversationTabsWiring.ts` |
| Live open-conversation IDs for webview hydration | `src/sidebar/liveConversationIds.ts` |
| Draft-discard confirmations for Close/Delete | `src/sidebar/conversationDraftDisposition.ts` |
| Conversation eviction signals, gathered from named sources | `src/sidebar/conversationEvictionSignals.ts` |
| Webview queue/draft retention state (including hydration unknown) | `src/sidebar/evictionGate.ts` |
| Live streamed-token estimate (status bar)            | `src/sidebar/LiveStreamMeter.ts`         |
| Host facade construction (remote/extension seam)     | `src/sidebar/sidebarFacadeWiring.ts`     |
| What the host facade forwards to (its construction contract) | `src/sidebar/hostFacadeDeps.ts`   |
| Ctx bar, HalluMeter bridge, thresholds               | `src/sidebar/ContextBudgetPublisher.ts`  |
| Per-request usage effects (token bar, output budget, cache stats) | `src/sidebar/requestUsageReporting.ts` |
| Chat create/switch/close/restore and capacity behavior | `src/sidebar/ConversationTabs.ts` |
| Resetting approval rules on open or archived conversation tabs | `src/sidebar/ConversationTabApprovals.ts` |
| Reposting a pending checkpoint affordance when a tab returns | `src/sidebar/ConversationTabCheckpoints.ts` |
| A tab's model VRAM release (switch, close, `/unloadModel`) | `src/sidebar/TabModelRelease.ts` |
| Chat-cap refusal wording (`chatCapMessage`) | `src/sidebar/sessionTypes.ts` |
| Hidden conversation notifications                    | `src/sidebar/hiddenChatAlerts.ts`        |
| Background process exit notice + end-of-turn still-running notice text | `src/sidebar/backgroundExitNotice.ts` |
| Shared typed/background/tool prompt delivery router | `src/sidebar/backgroundExitNotice.ts` |
| Tool-authored prompt entry into the shared router | `src/sidebar/SidebarProvider.ts` |
| Send admission, model resolution and request-chain orchestration | `src/sidebar/SendPipeline.ts`            |
| Per-conversation chain-settled listeners + worker-chat end-of-turn wake | `src/sidebar/workerChatWake.ts` |
| Per-conversation session-log lifecycle, event routing and cursor flush | `src/sidebar/SessionLogCoordinator.ts` |
| /reindex progress interaction                        | `src/sidebar/reindexCommand.ts`          |
| Primary turn + streaming lifecycle                   | `src/sidebar/AgentLoop.ts`               |
| Contact-prompt capacity gate (ready-slot reservation) | `src/sidebar/contactPrompt.ts`          |
| Shared Strata status read and serving-slot capacity    | `src/backend/strataStatus.ts`            |
| TurnServices object assembly (ctor extraction)       | `src/sidebar/turnServicesAssembly.ts`    |
| Out-of-band agent-progress pub/sub (safe dispatch)   | `src/sidebar/AgentProgressBus.ts`        |
| Sidebar attachment access (root URI + open)          | `src/sidebar/attachmentAccess.ts`        |
| Composer draft/attachment retention report           | `webview-ui/src/components/InputRow.tsx` + `useConversationDrafts.ts` + `useAttachments.ts` + `webview-ui/src/sessionRetentionMessages.ts` |
| Per-conversation streaming/cancel state              | `src/sidebar/TurnLifecycle.ts`           |
| Provider question wait suspension and resumption     | `src/sidebar/providerQuestionWait.ts`     |
| Model-endpoint turn: preflight + request             | `src/sidebar/ModelTurn.ts`               |
| Vision-only turn preflight and its owner-facing refusal | `src/sidebar/turnPreflight.ts` |
| Vision gate: single source of truth (advertise + refuse) | `src/sidebar/visionGate.ts`    |
| Model-facing message preparation for a turn (window, images, system prompt, turn context, tool-result excerpts) | `src/sidebar/prepareModelTurnMessages.ts` |
| Context-trim policy and per-conversation hysteresis state | `src/agent/toolResultContext.ts` |
| Per-round chat request assembly (native vs fallback tools, thinking kwargs, sampling, output cap) | `src/agent/buildRoundRequest.ts` |
| Tool-calling loop input and result contracts | `src/agent/toolCallingLoopTypes.ts` |
| Reasoning runaway detection (repetition loop and character cap, per request) | `src/agent/reasoningRunawayGuard.ts` |
| Cloud target / local backend startup                 | `src/sidebar/ProviderTurn.ts`            |
| Turn served by a local CLI agent                     | `src/sidebar/CliTurn.ts`                 |
| One-shot prompt (compaction, /review)                | `src/sidebar/PromptRun.ts`               |
| Thinking kwargs, strip, template context             | `src/sidebar/turnModelBehavior.ts`       |
| Collaborator set handed to turn modules              | `src/sidebar/turnServices.ts`            |
| Confirmation FIFO, the per-chat Clanker flag's live copy and its announcement | `src/sidebar/ToolApprovalService.ts` |
| First pending approval event for a conversation (read-through selection) | `src/sidebar/approvalEventLookup.ts` |
| Approval key and policy details passed to the confirmation queue | `src/sidebar/approvalCallOptions.ts` |
| Plain-language approval-card offer text | `src/sidebar/approvalMessages.ts` |
| `/approvals` listing and reset command | `src/sidebar/approvalSlashCommands.ts` |
| What a non-user approval means (outcome shape, decline text, denial errors) | `src/sidebar/toolApprovalOutcome.ts` |
| The approval card contract (request/resolved events, sink, the confirmRequest message) | `src/sidebar/toolApprovalEvents.ts` |
| Which chats have read a secret (the flag a later fetch pays for) | `src/tools/exfilTaint.ts` |
| Unattended conversation registry                      | `src/sidebar/unattendedConversations.ts` |
| Agent question: local box + remote answer            | `src/sidebar/UserQuestionService.ts`     |
| Question numbering, reply parsing, answer format     | `src/util/questionAnswers.ts`            |
| Shared question option selection rules | `src/util/questionPicks.ts` |
| `ask_user` schema and tool handoff | `src/tools/askUserTool.ts` |
| System browser launch for `open_url_in_browser` | `src/tools/systemBrowser.ts` |
| Agent notification: toast + remote fan-out           | `src/sidebar/UserNotificationService.ts` |
| Model residency polling timer                        | `src/sidebar/ResidencyPoller.ts`         |
| Timed pause for the agent loop                       | `src/tools/waitTool.ts`                  |
| Model-set elapsed-time check-in tool                 | `src/tools/setCheckinTool.ts`            |
| Linked-agent question ceiling and report handoff      | `src/agentBus/liveSessionLimit.ts`       |
| LSP read operations + strict `code_intel` dispatch   | `src/tools/codeIntelTool.ts`             |
| LSP code-action read/write handler                   | `src/tools/codeActionTools.ts`            |
| Guarded apply + save of a language-server WorkspaceEdit | `src/tools/workspaceEditApply.ts`     |
| Filesystem-miss error text for tools                 | `src/tools/pathErrorHint.ts`             |
| Pure filesystem-miss error text                      | `src/tools/pathMissText.ts`              |
| Owner-only write roots and open memory/skill exceptions | `src/tools/ownerPaths.ts` + `src/tools/ownerPathsOpen.ts` |
| Recycle-bin refusal diagnosis + short-lived path cache | `src/tools/trashRefusal.ts`             |
| Tool call execution + result formatting              | `src/sidebar/ToolDispatch.ts`            |
| Early refusals that stop a tool call before approval (cancelled, bad args, unknown/withheld tool, budget) | `src/sidebar/toolCallPreflight.ts` |
| Approval gate inputs and verdict for one tool call (shared by serial dispatch and parallel-read preflight) | `src/sidebar/toolApprovalEvaluation.ts` |
| Tool dispatch context and result-message types/helpers | `src/sidebar/toolDispatchTypes.ts`       |
| Ordered batching of independent read-only tool calls | `src/sidebar/ToolDispatchParallel.ts`     |
| Retired + unknown tool-name answers                  | `src/sidebar/retiredTools.ts`            |
| Delete approval preview and bounded inventory        | `src/sidebar/deletePreview.ts`           |
| Conversation CRUD pure ops                           | `src/sidebar/ConversationOps.ts`         |
| Slash command dispatch                               | `src/sidebar/SlashCommandHandler.ts`     |
| `/link` session picker (Claude registry, Codex thread list, by-hand fallback) | `src/sidebar/linkAgentPicker.ts` |
| `/chatMode` model picker and choice descriptions      | `src/sidebar/chatModeCommand.ts`          |
| `/init` (`/initForge`) agent turn that fills in FORGE.md | `src/sidebar/initForgeCommand.ts`      |
| Compaction: cut point, run, resume                   | `src/sidebar/CompactionService.ts`       |
| Compaction host-context assembly (preserved facts + candidate state) | `src/sidebar/compactionHostContext.ts` |
| Compaction between rounds of a running turn (policy) | `src/sidebar/midTurnCompaction.ts`       |
| Summary prompt text + summary validation             | `src/sidebar/compactionPrompt.ts`        |
| Summarizer transcript formatting + input shedding    | `src/sidebar/compactionSummarySource.ts` |
| One compaction summarize stage (host fit → summary; floor-mode retry runs it twice) | `src/sidebar/compactionStage.ts` |
| Compaction attempt hold/rearm + suppressed-attempt log row | `src/sidebar/compactionAttemptPolicy.ts` |
| Compaction attempt log rows (`compaction_attempt`)   | `src/sidebar/SessionLogger.ts`           |
| Compaction log row entry contracts                   | `src/sidebar/compactionLogTypes.ts`      |
| Admission-time auto-compact check                    | `src/sidebar/ContextBudgetPublisher.ts`  |
| Compaction error-to-category mapping (`compactionFailureCategory`) | `src/sidebar/compactionFailure.ts` |
| Host-fact fit (shed optional, then required to floors) | `src/sidebar/compactionHostFit.ts`       |
| Compaction service contract types (deps/options)     | `src/sidebar/compactionServiceTypes.ts`  |
| Summary run, one request, output cap                 | `src/sidebar/compactionSummaryRunner.ts` |
| Compaction budget math, `planOutput`, prompt fit     | `src/sidebar/compactionBudget.ts`        |
| Compaction tokenizer selection and per-model counter cache | `src/sidebar/compactionCounter.ts` |
| Applying the compaction window to a request          | `src/sidebar/compactionWindow.ts`        |
| Compaction message cost used by window measurement and split selection | `src/sidebar/compactionWindow.ts` |
| Frozen plan de-duplication and orphan-marker repair | `src/sidebar/turnContextPlanDedup.ts` |
| Host-recorded summary facts (from messages)          | `src/sidebar/compactionLedger.ts`        |
| Ledger merge, retention cap, omission count          | `src/sidebar/compactionRecordedState.ts` |
| Agent's last reply carried past a compaction         | `src/sidebar/compactionLastReply.ts`     |
| Compaction state contract and one-shot resume-note text | `src/sidebar/compactionTypes.ts` |
| Working-tree snapshot for a compaction               | `src/sidebar/repoSnapshot.ts`            |
| Agent task plan tool + plan rendering                | `src/tools/planTools.ts`                 |
| Volatile turn context (file, plan, remote, compaction resume note)           | `src/sidebar/turnContext.ts`             |
| Prompt KV-cache reuse stats from `usage`             | `src/llm/promptCacheStats.ts`            |
| Webview HTML builder                                 | `src/sidebar/WebviewBuilder.ts`          |
| Multi-conversation session types + persist           | `src/sidebar/sessionTypes.ts`            |
| Slim persisted message form (tool turns kept) and its ChatMessage conversion | `src/sidebar/slimPersist.ts` |
| Agent links: one session may hold several chats, current = newest `lastUsedAt` (sole `agentLinks` writer) | `src/agentLinks/chatAgentLinks.ts` |
| Linked-agent ask lifecycle and delivery policy | `src/agentLinks/askAgentService.ts` |
| Live linked-session transport contract, the panel-came-up wait, and delivery through a live session | `src/agentLinks/liveSessionDelivery.ts` |
| Structured linked-agent outcomes + tool rendering | `src/agentLinks/askAgentResult.ts` |
| Agent-to-agent send through linked chats, the steer that withdraws one, and the in-flight relay registry | `src/agentLinks/agentToAgentRelay.ts` |
| Sidebar-hosted linked-agent asks + checkpoint/cancel | `src/sidebar/sidebarAgentAsk.ts` |
| Pending background ask_agent exchanges (memory-only registry, cancel, end-of-turn notice) | `src/agentLinks/pendingAgentAsks.ts` |
| VS Code panel opening + linked-agent runtime | `src/agentLinks/askAgentRuntime.ts` |
| Inbound linked-agent reply and crash recovery | `src/agentLinks/agentReplyLifecycle.ts` |
| Durable inbound pending-reply records | `src/agentLinks/pendingAgentReplies.ts` |
| Inbound session-to-chat routing (`say` to the chat last addressed, `--to` any linked chat, `--new` adds one) | `src/agentLinks/inboundAgentRouting.ts` |
| Per-window agent-bus endpoint files | `src/agentBus/windowEndpoints.ts` |
| Agent endpoint publication lifecycle | `src/backend/agentWindowEndpointRegistry.ts` |
| Inbound agent message routing/admission | `src/backend/agentInboundAdmission.ts` |
| Agent relay routing between linked chats | `src/backend/agentRelayDispatch.ts` |
| Inbound session identity validation (agent senders and plain bus sender names) | `src/backend/agentSenderParsing.ts` |
| Sidebar link-routing facade dependencies | `src/sidebar/agentLinkFacadeDeps.ts` |
| `ask_agent` strict tool boundary | `src/tools/askAgentTool.ts` |
| `message_chat` schema, config-gated advertisement, and list/send dispatch | `src/tools/messageChatTool.ts` |
| `message_chat` delivery caps, new/steer actions, and steering guards | `src/tools/messageChatActions.ts` |
| Chat-to-chat message text: header format/parse (incl. 0.17.73-74 legacy), short titles, Telegram mirror lines | `src/sidebar/chatMessageText.ts` |
| Solo/multi chat mode for Strata launchers and llama.cpp slots | `src/config/ChatMode.ts` |
| Effective llama.cpp request-slot count shared by pool and chat mode | `src/backend/parallelCapacity.ts` |
| `message_chat` reference resolution and chat-list formatting | `src/tools/chatMessageResolver.ts` |
| `message_chat` peer windows: discovery, chat lists, limits, window/chat matching | `src/tools/messageChatPeers.ts` |
| `message_chat` cross-window chat-id prefix resolution and ambiguity | `src/tools/messageChatPeerTarget.ts` |
| `message_chat` refusal and local message formatting | `src/tools/messageChatToolFormatting.ts` |
| Conversation runtime and persisted schema | `src/sidebar/sessionTypes.ts` |
| Per-conversation AgentLoop disposal and runtime-state cleanup | `src/sidebar/agentConversationDisposal.ts` |
| `message_chat` cross-window send/steer/new/view | `src/tools/messageChatPeerActions.ts` |
| Bounded peer HTTP transport (one deadline, uncertain answers) | `src/agentBus/peerHttp.ts` |
| This window's own bus identity (window id, bus root) | `src/agentBus/selfWindow.ts` |
| `AgentRoutesDeps` + `AgentRelayResult` (the route dependency contract) | `src/backend/agentRoutesDeps.ts` |
| Copilot one-shot CLI argv and output parsing | `src/agents/adapters/copilotAdapter.ts` |
| Conversation titles: placeholder + derive + `title_source` | `src/sidebar/conversationTitle.ts`       |
| Host-facing conversation summary (title, counts, `titleSource`) | `src/sidebar/hostConversationSummary.ts` (types in `ForgeHostFacade.ts`) |
| Image content parts: count/strip/age out             | `src/sidebar/imageParts.ts`              |
| Missing-image notices to the user                    | `src/sidebar/imageNotices.ts`            |
| Session load/save/migrate (workspaceState; open-chat v2 delegated to `openConversationsPersistence`) | `src/sidebar/sessionPersistence.ts` |
| Open-chat v2 memento, v1 merge/shrink, inline fallbacks, commit/prune ordering, `persistMemento` | `src/sidebar/openConversationsPersistence.ts` |
| Atomic per-id conversation body files (load/quarantine, signatures, deferred removal) | `src/sidebar/ConversationBodyStore.ts` |
| History legacy-list migration + overflow wiring (bodies via `ConversationBodyStore`) | `src/sidebar/HistoryArchive.ts` |
| Overflow archived-session bodies and index           | `src/sidebar/ArchivedSessions.ts`        |
| Shipped helper scripts for hand or agent use (`tools/user/`) | `tools/user/README.md` lists each; downloads **Forge** itself makes stay owned by `src/jobs/jobsFetch.ts` |
| Starter `FORGE.md` text written into a new workspace | `src/llm/ForgeInstructionsLoader.ts` (`STARTER_CONTENT`) |
| Session -> webview projections (rows, metas, counts) | `src/sidebar/sessionProjections.ts`      |
| First-run setup wizard                               | `src/sidebar/FirstRunWizard.ts`          |
| Add-model setup wizard                               | `src/sidebar/AddModelWizard.ts`          |
| Missing-config setup mode                            | `src/sidebar/SetupMode.ts`               |
| AI setup handoff (prompt for Claude Code / Codex)    | `src/vscode/agentSetupCommand.ts` + `AI_SETUP.md` |
| Keep/Undo CodeLens decorations                       | `src/sidebar/KeepUndoCodeLens.ts`        |
| Typed webview ↔ host message contract                | `src/sidebar/messageBridge.ts`           |
| Webview diagnostic message shapes                    | `src/sidebar/diagnosticMessages.ts`      |
| Conversation-tab webview message shapes              | `src/sidebar/conversationMessages.ts`    |
| "Open this in the editor" message shapes             | `src/sidebar/openMessages.ts`            |
| Queued-chip message shapes (Cancel, Send now)        | `src/sidebar/tellMessages.ts`            |
| Model-picker message shapes (labels, residency)      | `src/sidebar/modelMessages.ts`           |
| Model-picker groups + their order (presentation only) | `src/sidebar/ModelPickerGroups.ts`       |
| Diff shapes, `fileDiff`, `diffStats`, checkpoint stats | `src/sidebar/diffMessages.ts`            |
| Checkpoint bar net stats (snapshot vs disk)          | `src/sidebar/checkpointStats.ts`         |
| Chat attachment bytes on disk (thumbnails)           | `src/sidebar/ChatAttachmentStore.ts`     |
| In-editor green/red diff decorations                 | `src/sidebar/DiffDecorations.ts`         |
| Diff computation + unified-diff parsing              | `src/sidebar/DiffUtils.ts`               |
| Per-call diff-card base (file before one tool call) | `src/sidebar/callDiffBase.ts`            |
| Session transcript logging (~/.forge)                | `src/sidebar/SessionLogger.ts`           |
| The gate ledger: one `gate` row per card, timeout, guard refusal | `src/sidebar/gateEventLog.ts` |
| Replay-aware session-log row reading                 | `src/sessions/sessionLogRows.ts`         |
| Per-request prompt-head fingerprint (`request_prefix` rows: hashes and counts, no text) | `src/sessions/requestFingerprint.ts` |
| Per-request server/client stats (`request_stats` rows: numbers only) | `src/sessions/requestStats.ts` |
| Recovering the session-log write cursor after a window reload | `src/sessions/sessionCursor.ts` |
| Per-turn server timings summed into one speed line, and the rule that a turn with no server timings gets no line | `src/sessions/turnSpeedTotals.ts` |
| Opt-in request-body dump writes, pruning and conversation deletion | `src/sessions/requestDump.ts` |
| Tool visibility and shell-workaround audit (daily files in ~/.forge/tool-usage/) | `src/sessions/toolUsage.ts` |
| Tool-call argument summary labels                    | `src/sidebar/toolSummary.ts`             |
| Runtime capability memo + warn-once ledger           | `src/sidebar/CapabilityCache.ts`         |
| Model/config mismatch warnings a turn reports (thinking toggle, chat template, per-slot `max_tokens`) | `src/sidebar/modelMismatchWarnings.ts` |
| Status-bar and turn-counter events `extension.ts` hands the sidebar | `src/sidebar/statusBarTurnEvents.ts` |

## Chat webview transcript

| Concern                                         | Owner                                           |
| ----------------------------------------------- | ----------------------------------------------- |
| Streamed assistant turn finalization            | `src/agent/StreamedAssistantTurn.ts`            |
| Webview state reducer (per-conversation keying) | `webview-ui/src/reducer.ts`                     |
| Session snapshot reconciliation and transcript cache lifecycle | `webview-ui/src/sessionSyncReducer.ts`          |
| Pending prompts, queue flush, and mid-turn tells | `webview-ui/src/usePendingPrompts.ts`           |
| Fire-and-forget webview→host commands           | `webview-ui/src/hostCommands.ts`                |
| Host message → reducer action mapping           | `webview-ui/src/hostActions.ts`                 |
| Approval + per-question state and drafts | `webview-ui/src/useAgentDialogs.ts` |
| Agent question shell, tabs and keyboard | `webview-ui/src/components/QuestionDialog.tsx` |
| Agent question body and options | `webview-ui/src/components/QuestionBody.tsx` |
| Agent question review step | `webview-ui/src/components/QuestionReview.tsx` |
| Agent question card theme | `webview-ui/styles/question-card.css` |
| Escape rule for the docked agent dialogs        | `webview-ui/src/useDockedDialogEscape.ts`       |
| Transcript row folding (diff / thinking runs)   | `webview-ui/src/components/MessageList.tsx`     |
| Active transcript pane lifecycle               | `webview-ui/src/components/TranscriptPanes.tsx` |
| Transcript paging, page folding, and prepend viewport anchor | `webview-ui/src/useTranscriptWindow.ts` |
| Single-file diff rendering + stats              | `webview-ui/src/components/DiffBlock.tsx`       |
| Per-turn multi-file diff summary card           | `webview-ui/src/components/DiffGroup.tsx`       |
| Top-level reasoning blocks                    | `webview-ui/src/components/ThinkingGroup.tsx`   |
| Shared tail-preview folding for thinking + tool output | `webview-ui/src/components/FoldedContent.tsx` |
| Tool call rows + expandable results (`ToolResultContent`) | `webview-ui/src/components/ToolRow.tsx` |
| Model picker dropdown (grouped, opens upward)   | `webview-ui/src/components/ModelSelector.tsx`   |
| History panel shell: tabs, search, resize, dismissal | `webview-ui/src/components/HistoryList.tsx`     |
| History panel rows (chat, open tab, job) and their badges | `webview-ui/src/components/HistoryChatRow.tsx` (open rows, `relativeTime`), `HistoryJobRow.tsx` |
| What one tab of the panel shows: rows, empty, no-match | `webview-ui/src/components/HistoryTabContent.tsx` |
| Panel row display rules: search ranking and job status | `webview-ui/src/historyFilter.ts` (title/badge metadata plus scored host results for saved text) |
| Sessions panel search box: when it asks, which answer is still current | `webview-ui/src/sessionContentSearch.ts` (hook); host walk: `src/sidebar/sessionContentSearch.ts`; wire shapes + query validation: `src/sidebar/sessionSearchMessages.ts` |
| What a chat content search may match (message text, not tool output, reasoning or hidden turns) | `src/sidebar/sessionContentSearch.ts` (`transcriptSearchText`, `sessionLogSearchText`) |
| Session search query language, relevance scoring and highlight spans | `src/sidebar/sessionSearchQuery.ts`; safe preview rendering: `webview-ui/src/components/SessionSearchPreview.tsx` |
| Shared chat title and sender-badge projection (host search + panel) | `src/sidebar/chatProvenance.ts` (`historyFilter.ts` re-exports it) |
| Async, read-only archive reads for the search (`readForSearch`: never quarantines or deletes) | `src/sidebar/ArchivedSessions.ts` |
| Session-log line split + replay decode, from disk or from text in hand | `src/sessions/sessionLogRows.ts` (`readSessionLogRows`, `parseSessionLogRows`) |
| Panel size contract (bounds, clamp) and its `globalState` half | `src/sidebar/historyPanelSize.ts`; stored and read back: `src/sidebar/historyPanelSizeStore.ts` |
| Sessions panel row shapes, host + webview contract | `src/sidebar/sessionMetaMessages.ts` (mirrored through `src/sidebar/messageBridge.ts`) |
| Panel resize by pointer, arrow keys and reset (hook) | `webview-ui/src/useResizablePanel.ts` |
| Single-chat header (title, history, new chat)   | `webview-ui/src/components/ChatHeader.tsx`      |
| Empty-tab backend state (mark + residency line) | `webview-ui/src/components/EmptyState.tsx`      |
| Resumed-tab rule + marker wording               | `webview-ui/src/resumedTabs.ts`                 |
| Staged attachment state + file validation       | `webview-ui/src/components/useAttachments.ts`   |
| Attachment tiles, size budget, reject notices   | `webview-ui/src/components/AttachmentTray.tsx`  |
| Message list ops + session-sync reconciliation  | `webview-ui/src/messageOps.ts`                  |
| Webview state shape, selectors, action union    | `webview-ui/src/appState.ts`                    |
| Render-time path/URL linkification              | `webview-ui/src/linkify.ts`                     |
| Tool result labelling + who-approved prefix for the transcript | `src/sidebar/toolResultView.ts` |
| Checkpoint review (virtual pre-turn documents)  | `src/sidebar/CheckpointReview.ts`               |
| Undo-history depth cap + review snapshots       | `src/checkpoint/checkpointHistory.ts`           |
| Attachment tray/tile styles (composer)          | `webview-ui/styles/attachments.css`             |
| Diff card styles                                | `webview-ui/styles/diff.css`                    |
| Tool + thinking row styles                      | `webview-ui/styles/tool-rows.css`               |
| Empty-tab styles                                | `webview-ui/styles/empty-state.css`             |
| Sessions panel styles                           | `webview-ui/styles/sessions-panel.css`          |
| Chat header styles                              | `webview-ui/styles/chat-header.css`             |
| Residency dot colours (reused by the empty tab) | `webview-ui/styles/model-selector.css`          |

## Model Manager (F7/§2.3)

| Concern                                        | Owner                                           |
| ---------------------------------------------- | ----------------------------------------------- |
| Typed webview ↔ host message contract          | `src/sidebar/modelManager/messages.ts`          |
| Panel lifecycle + message dispatch (singleton) | `src/sidebar/modelManager/ModelManagerPanel.ts` |
| Panel HTML/CSP/nonce builder                   | `src/sidebar/modelManager/panelHtml.ts`         |
| Full-state assembly (stateless view contract)  | `src/sidebar/modelManager/modelSnapshot.ts`     |
| Group/defaults merge + inherited-key detection | `src/sidebar/modelManager/resolvedView.ts`      |
| Field edit / remove / purge write path         | `src/sidebar/modelManager/editOps.ts`           |
| Scan → candidate list → auto-generated entries | `src/sidebar/modelManager/scanOps.ts`           |
| Groups ("boards") editor write path            | `src/sidebar/modelManager/groupsOps.ts`         |
| `last_used` tracking (.forge/state.json)       | `src/sidebar/modelManager/usageTracker.ts`      |
| Webview entry point + master-detail shell      | `webview-ui/src/modelManager/App.tsx`           |
| Webview state reducer                          | `webview-ui/src/modelManager/reducer.ts`        |
| Webview host bridge wrapper                    | `webview-ui/src/modelManager/vscode.ts`         |

## Remote control

| Concern                                       | Owner                                           |
| --------------------------------------------- | ----------------------------------------------- |
| Extension-scoped transport lifecycle          | `src/remote/RemoteRuntime.ts`                   |
| A config reload that keeps the transports up  | `src/remote/remoteRuntimeInPlaceUpdate.ts`      |
| Transport start/stop, lease takeover          | `src/remote/RemoteTransportManager.ts`          |
| Telegram window reload reservation and `/reload` recovery | `src/remote/remoteReloadReservation.ts` |
| Retry timer + policy for failed remote starts | `src/remote/RemoteStartRetry.ts`                |
| `/workspace` move, run after the cursor save  | `src/remote/remoteWorkspaceSwitch.ts`           |
| One window record per VS Code window, and the open-window count | `src/remote/RemoteWindowRegistry.ts`       |
| Close-request/result files; a window deciding on its own Close | `src/remote/RemoteWindowClose.ts`               |
| OS window count on Windows (`pwsh` + `Add-Type`, degrades to the files) | `src/remote/RemoteWindowsProbe.ts` |
| `/workspace windows`, its `✕` per row, `/workspace cap` | `src/remote/remoteWorkspaceWindows.ts`   |
| This window's 5 s watch: claim retry, come-back, close inbox | `src/remote/RemoteWindowWatch.ts`              |
| Bound-chat workspace file delivery            | `src/remote/remoteFileDelivery.ts`              |
| Remote transport validation status projection | `src/remote/remoteValidationStatus.ts`          |
| Inbound admission, queue drain, notifications | `src/remote/RemoteController.ts`                |
| Authenticated text routing priority order     | `src/remote/remoteTextRouting.ts`               |
| Remote command dependency assembly             | `src/remote/remoteCommandDeps.ts`               |
| Remote ownership/authentication gate           | `src/remote/remoteAuthGate.ts`                  |
| Ephemeral remote message cleanup policy       | `src/remote/RemoteEphemeralMessages.ts`         |
| Durable normal prompt admission               | `src/remote/RemotePromptAdmission.ts`           |
| Durable queue execution + terminal outcome    | `src/remote/RemoteQueueDrain.ts`                |
| Retry a failed remote claim settlement         | `src/remote/remoteClaimSettle.ts`               |
| Pairing + session-auth facade                 | `src/remote/RemoteAuth.ts`                      |
| TOTP session state + enrollment boundary      | `src/remote/RemoteSessionAuth.ts`               |
| Prompt held across a TOTP challenge           | `src/remote/RemotePendingPrompt.ts`             |
| Agent question presented in the remote chat   | `src/remote/RemoteQuestionBridge.ts`            |
| Pure remote question step state and transitions | `src/remote/RemoteQuestionSteps.ts` |
| RFC 6238 generation/verification              | `src/remote/RemoteTotp.ts`                      |
| Durable requests, bindings, cursors, outbox   | `src/remote/RemoteRequestStore.ts`              |
| Host outbox notification draft mutation        | `src/remote/remoteOutboxDraft.ts`               |
| Pure request and outbox health queries        | `src/remote/remoteStoreQueries.ts`              |
| Remote owner command behavior                 | `src/remote/RemoteCommandHandler.ts`            |
| Command argument → id, and miss messages      | `src/remote/remoteCommandSelectors.ts`          |
| `/workspace <n>` switch preflight             | `src/remote/remoteWorkspaceCommand.ts`          |
| `/clanker`, `/timeout`, `/ratelimit`          | `src/remote/remoteSettingsCommands.ts`            |
| `/models`, `/model`, `/system`, unload        | `src/remote/remoteModelCommands.ts`               |
| Shared helpers: busy check, progress edit     | `src/remote/remoteCommandShared.ts`               |
| /sleep, /wake, sleep confirmation state       | `src/remote/RemotePowerCommands.ts`             |
| Queue order, promote/cancel/claim rules       | `src/remote/remoteQueueOrdering.ts`             |
| Lease owner liveness and claim recovery        | `src/remote/remoteClaimLiveness.ts`             |
| Claim a queued request as a mid-turn tell     | `src/remote/RemoteMidTurnTells.ts`              |
| Telegram Send now receipt callbacks + registry | `src/remote/TelegramSendNowButton.ts`            |
| Promote a queued request from its receipt      | `src/remote/remoteSendNow.ts`                    |
| Turn outcome echoed to bound chats            | `src/sidebar/turnMirrorWiring.ts`               |
| Live progress message for a sidebar turn      | `src/remote/remoteHostProgress.ts`              |
| Remote turn progress (event routing, footer state, out-of-band sends) and pure status-footer rendering | `src/remote/RemoteAgentProgress.ts`, `src/remote/remoteProgressRender.ts` |
| Remote Stop action resolution                  | `src/remote/RemoteStopActions.ts`              |
| A turn's live chat bubbles: one per text block, status footer and Stop only on the newest, throttled coalesced edits, 429 re-render, 4096-char split | `src/remote/RemoteLiveBubble.ts` |
| Opening a turn's first progress bubble, shared by the queue drain and the sidebar mirror | `src/remote/remoteProgressOpen.ts` |
| `/view` transcript replay rendering           | `src/remote/RemoteTranscriptView.ts`            |
| Paged /list, /models, /workspace selections   | `src/remote/RemoteSelectionPager.ts`            |
| Direct HTML formatting for numeric picker pages | `src/remote/remoteSelectionFormat.ts`          |
| Selection list identity, token, expiry        | `src/remote/RemoteSelectionState.ts`            |
| Sibling-workspace discovery + alias merge     | `src/remote/RemoteWorkspaceDiscovery.ts`        |
| Chat handoff between workspace windows        | `src/remote/RemoteWorkspaceHandoff.ts`          |
| Handoff record state transitions              | `src/remote/RemoteHandoffState.ts`              |
| Live handoff claim + switch rollback          | `src/remote/RemoteHandoffCoordinator.ts`        |
| Remote state file: lock, reclaim, first read  | `src/remote/remoteStateFile.ts`                 |
| Telegram selection keyboard + callback codec  | `src/remote/TelegramSelectionPagination.ts`     |
| Telegram command shortcut callback codec      | `src/remote/TelegramCommandButtons.ts`          |
| Telegram job callback codec                    | `src/remote/TelegramJobButtons.ts`              |
| Telegram queue callback codec                  | `src/remote/TelegramQueueButtons.ts`            |
| Telegram callback query mapping                | `src/remote/telegramCallbackMapping.ts`         |
| Telegram report button action routing           | `src/remote/RemoteReportCallbacks.ts`            |
| Telegram job list and card rendering             | `src/remote/remoteJobReport.ts`                  |
| Telegram status/context report and commands      | `src/remote/remoteStatusReport.ts`              |
| Telegram report bars and short token counts      | `src/remote/telegramReportFormat.ts`             |
| Memory-only linked-agent force-reply rendezvous  | `src/remote/remoteAgentAsk.ts`                  |
| Bot API inline keyboard markup and callback limit | `src/remote/telegramInlineKeyboard.ts`          |
| Remote absolute and relative date formatting      | `src/remote/RemoteDateTime.ts`                   |
| Forge approval presentation + correlation     | `src/remote/RemoteApprovalBridge.ts`            |
| Telegram Bot API transport                    | `src/remote/TelegramChannel.ts`                 |
| Telegram media multipart transport            | `src/remote/TelegramMedia.ts`                   |
| Telegram `/media`, `/video`, `/music` dispatch | `src/remote/RemoteMediaCommands.ts`             |
| Telegram group-contact workflow (link, /owner) | `src/remote/TelegramGroupContacts.ts`          |
| Owner-approved contact records (who may speak, group links, thread, outbound) | `src/remote/remoteContactRecords.ts` |
| Telegram command-text parsing helpers         | `src/remote/telegramContactText.ts`             |
| Telegram outbound sends, edits, and media | `src/remote/TelegramOutbound.ts`                   |
| Telegram status-bubble ⏹ Stop button (inline markup, U+2800 widening, callback codec, legacy key label) | `src/remote/TelegramStopButton.ts` |
| Telegram photo send + document fallback       | `src/remote/TelegramPhoto.ts`                   |
| Per-chat send ordering + Bot API 429 retry    | `src/remote/telegramSendQueue.ts`               |
| Telegram HTML escaping + line markup helpers  | `src/remote/telegramHtml.ts`                    |
| Telegram notice emoji + blockquote styling   | `src/remote/telegramNoticeStyle.ts`             |
| /help command map text + its markup           | `src/remote/remoteHelpText.ts`                  |
| WhatsApp linked-device transport              | `src/remote/whatsapp/BaileysWhatsAppChannel.ts` |
| Local setup/validation commands               | `src/vscode/remoteCommands.ts`                  |

## CLI agent lifecycle

| Concern                                              | Owner                                 |
| ---------------------------------------------------- | ------------------------------------- |
| Shared CLI spawn and process-tree cleanup            | `src/agents/cliProcess.ts`            |
| One-shot delegation CLI execution                    | `src/agents/CliAgentDriver.ts`        |
| Warm direct-chat CLI process lifecycle               | `src/agents/CliAgentSession.ts`       |
| Warm CLI start gating and failure reporting          | `src/agents/cliStartFailure.ts`      |
| Codex app-server JSON-RPC session                    | `src/agents/CodexAppServerSession.ts` |
| JSON-RPC-over-stdio framing + correlation            | `src/agents/jsonRpcStdio.ts`          |
| Codex turn text assembly + de-duplication            | `src/agents/codexTurnText.ts`         |
| Codex app-server sandbox launch flags                | `src/agents/codexAppServerArgs.ts`    |
| Conversation/model ownership, cap, and idle eviction | `src/agents/CliSessionRegistry.ts`    |
| Direct-chat CLI run (cold + warm) and task text      | `src/agents/CliChatRunner.ts`         |
| Codex approval decisions (bounded autonomy)          | `src/agents/CodexApprovalPolicy.ts`   |
| Pre-run disk checkpoint for full-access CLIs         | `src/agents/WorkspaceCheckpoint.ts`   |
| Windows `.cmd` shim quoting + Node launcher          | `src/agents/windowsCmdShim.ts`        |
| Windows PATH refresh for CLI spawns                  | `src/agents/windowsUserPath.ts`       |

## Backend

| Concern                                           | Owner                                  |
| ------------------------------------------------- | -------------------------------------- |
| Mode-agnostic backend interface                   | `src/backend/BackendController.ts`     |
| Multi-backend lifecycle + port allocation         | `src/backend/BackendPool.ts`           |
| Cancellable turn-lease acquisition                 | `src/backend/turnLeaseAcquisition.ts`   |
| Backend pool activation, shared-runtime lease and external-model shutdown | `src/vscode/backendPoolSetup.ts` |
| Remote (laptop) model starter HTTP surface: four routes, `127.0.0.1`, no token; delegates listener lifecycle to TailnetListener | `src/backend/ModelStarterServer.ts`    |
| Desktop tailnet services activation, config reload and disposal wiring | `src/vscode/tailnetServicesSetup.ts` |
| :8799 control server construction, registry, agent routes and VS Code commands | `src/vscode/controlServerSetup.ts` |
| Shared loopback listener for Tailscale-exposed services: bind/rebind, request guards, body cap, and the streamed route a handler takes unread | `src/backend/TailnetListener.ts` |
| Shared JSON request/response helpers, independent of chat routing        | `src/backend/httpJson.ts`              |
| Remote lease map, TTL sweep and exactly-once release | `src/backend/ModelStarterLeases.ts`   |
| Model starter servability matrix + `POST /ensure` load and pin | `src/backend/ModelStarterEnsure.ts`   |
| Model starter pass-through: `/<model>/v1/<openai path>` forwarded byte for byte to the port that model is on, target set = `remote: true`, streams aborted on disconnect | `src/backend/ModelStarterPassThrough.ts` |
| Laptop "Connect to my desktop": the two desktop reads (the relay read shared with "Check connection"), the tailnet picker, one config write that never runs a model, the once-per-window keeping-up notice | `src/vscode/desktopConnect.ts` |
| What Connect decides: the laptop entry field table, the "already there" rule, the relay groups, the starter/relay address choice, the result message | `src/vscode/desktopConnectPlan.ts` |
| The once-per-laptop-window keeping-up notice: one read, one "Add them", "Not now" remembered for the window only | `src/vscode/desktopKeepingUp.ts` |
| The laptop's "Check connection": the five-link walk, the first broken link named in plain words, the address choice reused from `RemoteStarterRoute`, nothing started and nothing written | `src/vscode/desktopCheckConnection.ts` |
| Desktop "Share this computer" and "Stop sharing": the confirmed dialog, the one comment-preserving switch write, the two `serve` changes and the window kinds that do nothing at all | `src/vscode/desktopShare.ts` |
| What Share and Stop sharing decide: which two ports are shared and which two are never named, the two config switches, the created blocks' required fields, and which shares the run leaves still open | `src/vscode/desktopSharePlan.ts` |
| The two warnings and the messages after a Share or Stop run: the ACL note, the hosted-window refusal, and the ports still shared that the message has to name | `src/vscode/desktopShareText.ts` |
| The `tailscale serve` shapes: the share and unshare argv, the command as the owner pastes it, and what `serve status --json` already forwards | `src/vscode/tailscaleServe.ts` |
| The Tailscale CLI run argv-only from one place: the install locations, the 4 s read and 15 s write deadlines, the caller's abort and the one not-found message | `src/vscode/tailscaleCli.ts` |
| BackendPool VRAM release: external coordination, local teardown, one-model release | `src/backend/BackendPoolExternal.ts` |
| Start / Restart Backend commands: route a managed server to `prepareExternal`, else `acquire` | `src/backend/restartBackend.ts` |
| llama.cpp slot table + LRU eviction               | `src/backend/poolSlots.ts`             |
| Ollama + borrowed-runtime acquisition, and the pool-side busy refusal (`ExternalBusyError`) | `src/backend/poolAcquisition.ts` |
| Delegation capacity check + eviction pins         | `src/backend/DelegationGate.ts`        |
| Direct mode (llama-server spawn)                  | `src/backend/DirectBackend.ts`         |
| Adopted llama-server health polling               | `src/backend/adoptedServerMonitor.ts`  |
| llama-server and sd-server process spawn/teardown | `src/backend/llamaProcess.ts`          |
| Embedding llama-server (semantic search)          | `src/backend/EmbeddingBackend.ts`      |
| stable-diffusion.cpp server lifecycle             | `src/backend/SdServerBackend.ts`       |
| stable-diffusion.cpp owner records + Windows process identity | `src/backend/sdServerOwnerRecord.ts` |
| stable-diffusion.cpp cross-window adoption       | `src/backend/sdServerAdoption.ts`      |
| stable-diffusion.cpp argv and process signature   | `src/backend/sdServerArgs.ts`          |
| stable-diffusion.cpp readiness + stderr diagnostics | `src/backend/sdServerReadiness.ts`   |
| stable-diffusion.cpp start-time process identity  | `src/backend/sdServerReconciliation.ts` |
| stable-diffusion.cpp idle-stop policy: the owner's idle timer and the orphan sweep | `src/backend/sdServerIdle.ts` |
| one `SdServerBackend` per configured sdcpp backend  | `src/backend/sdServerRegistry.ts`    |
| External server log → output channel (`server_log`) | `src/backend/serverLogFollower.ts`   |
| Unloading local servers Forge does not spawn (`unload_path`, Strata) | `src/backend/ExternalModelServers.ts` |
| The detached deferred-stop watcher a managed external server leaves behind (`stop_command`, grace period, lease re-check) | `src/backend/ExternalServerStopWatcher.ts` |
| Managed external server residency classification (`/v1/models` and stale `/v1/status` claims) | `src/backend/ExternalModelResidencyProbe.ts` |
| Deferred `stop_on_exit` watcher (reload vs close) | `src/backend/deferredStop.ts` |
| Localhost model-control HTTP API                  | `src/backend/ControlServer.ts`         |
| Localhost control-server session statistics (`GET /stats`) | `src/backend/controlStats.ts`          |
| Control-server load/capacity/unload               | `src/backend/ControlModelLifecycle.ts` |
| Control-server HTTP/serialization helpers         | `src/backend/controlHttp.ts`           |
| `/agent/message` option, origin-chat and peer-writer id validation | `src/backend/agentMessageOptions.ts`    |
| `/models` catalog contract + availability         | `src/backend/ControlModelCatalog.ts`   |
| Control-server discovery records (LOCALAPPDATA)   | `src/backend/ControlServerRegistry.ts` |
| Machine-wide llama.cpp runtime discovery + leases | `src/backend/SharedRuntimeRegistry.ts` |
| Machine-wide managed-external turn holds (record dir, TTL, refresh interval, lock) | `src/backend/ExternalTurnHolds.ts` |
| Backend pool contract (IBackendPool)              | `src/backend/poolTypes.ts`             |
| Slot boot/restart + dead-slot reconcile           | `src/backend/poolStart.ts`             |
| llama-server stdio/exit diagnostics               | `src/backend/serverDiagnostics.ts`     |
| GGUF/mmproj existence + served-model match        | `src/backend/modelFileChecks.ts`       |
| Structural settings pinned across hot reload      | `src/backend/poolStructuralConfig.ts`  |
| Process-liveness check (stale resource reclaim)   | `src/util/processLiveness.ts`          |
| llama-server CLI arg builder                      | `src/backend/LlamaServerArgs.ts`       |
| Ollama endpoint normalization + health            | `src/backend/OllamaAdapter.ts`         |
| Backend health polling                            | `src/backend/HealthCheck.ts`           |
| GGUF file scanner                                 | `src/backend/GgufScanner.ts`           |
| Model family heuristics                           | `src/backend/ModelHeuristics.ts`       |
| Runtime model capability detection                | `src/backend/ModelCapabilities.ts`     |

## Delegation

| Concern                                       | Owner                                      |
| --------------------------------------------- | ------------------------------------------ |
| Delegation orchestration (local + cloud)      | `src/delegation/LocalDelegationService.ts` |
| Delegation target eligibility                 | `src/delegation/eligibility.ts`            |
| Delegation limits + prompt contract           | `src/delegation/limits.ts`                 |
| `ask_local_agent` for `provider: cli` targets | `src/delegation/CliDelegationRunner.ts`    |

## CLI Agents (`provider: cli` — F7/§2.4)

| Concern                                              | Owner                                  |
| ---------------------------------------------------- | -------------------------------------- |
| Shared types (adapter contract, event/result shapes) | `src/agents/types.ts`                  |
| Spawn/stream/cancel/timeout lifecycle                | `src/agents/CliAgentDriver.ts`         |
| PATH/absolute-path executable resolution             | `src/agents/resolveCliExecutable.ts`   |
| Structured driver error type                         | `src/agents/CliAgentError.ts`          |
| Per-CLI adapter registry                             | `src/agents/adapters/index.ts`         |
| Claude Code stream-json adapter                      | `src/agents/adapters/claudeAdapter.ts` |
| Codex JSONL adapter                                  | `src/agents/adapters/codexAdapter.ts`  |

## LLM / Inference

| Concern                                      | Owner                                        |
| -------------------------------------------- | -------------------------------------------- |
| Unified chat dispatch (llama.cpp + Ollama)   | `src/llm/ChatClient.ts`                      |
| Cloud provider registry + base URLs          | `src/llm/CloudProviders.ts`                  |
| Cloud request URL + secret resolution        | `src/llm/CloudRequestResolver.ts`            |
| Key-based cloud models in a VS Code Remote window: the desktop-relay rule, the 2 s `/v1/models` probe and its four messages | `src/llm/RemoteWindowRoute.ts` |
| Remote (laptop) model starter client: ask the desktop to start or load, hold and renew its lease, remote unload | `src/llm/RemoteStarterClient.ts` |
| Remote starter HTTP: one POST to one address, the two read-only GETs a laptop makes (`GET /models`, the relay's `GET /v1/models`), the status messages, the unreachable classification | `src/llm/RemoteStarterHttp.ts` |
| Which starter address a laptop dials: probe order, the 2.5 s `GET /models` probe, the remembered route and its re-choose rules | `src/llm/RemoteStarterRoute.ts` |
| Desktop cloud relay HTTP surface and lifecycle | `src/llm/CloudRelayServer.ts`               |
| Cloud relay provider forwarding, header filtering and stream scrubbing | `src/llm/CloudRelayForward.ts` |
| Local/cloud route classification             | `src/llm/ModelRouteClassifier.ts`            |
| Shared native/fallback tool-calling loop     | `src/agent/ToolCallingLoop.ts`               |
| Mid-turn tell inbox                          | `src/agent/MidTurnInbox.ts`                  |
| Mid-turn tell composer (sidebar + remote)    | `src/agent/MidTurnTellDrain.ts`              |
| Undelivered tells at turn end (batch, restore, Send now) | `src/sidebar/undeliveredTells.ts`     |
| Elapsed-time note (mid-turn tell source)     | `src/agent/elapsedTimeNote.ts`               |
| Tool-calling stream helpers                  | `src/agent/toolCallingStream.ts`             |
| Truncated tool call: detection + recovery    | `src/agent/truncationRecovery.ts`            |
| Repeated identical tool call detection       | `src/agent/ToolLoopGuard.ts`                 |
| Fit-only tool-result excerpting (model copy) | `src/agent/toolResultContext.ts`             |
| Re-read annotation (model copy)              | `src/agent/staleReadSupersede.ts`            |
| Chat message / tool call wire types          | `src/llm/types.ts`                           |
| Buffered in-host chat for POST /chat         | `src/llm/ControlChatProxy.ts`                |
| xAI token resolution (SecretStorage/OAuth)   | `src/llm/XaiAuth.ts`                         |
| FORGE.md workspace instructions loader       | `src/llm/ForgeInstructionsLoader.ts`         |
| FORGE.md chain assembly + byte budget        | `src/llm/forgeInstructionsChain.ts`          |
| Per-chat pinned FORGE.md text + change note  | `src/sidebar/forgeInstructionsPin.ts`        |
| Streaming OpenAI-compat client               | `src/llm/OpenAIClient.ts`                    |
| Provider wire-message filtering and mid-turn text | `src/llm/wireRequest.ts`                  |
| Stream idle watchdog + stall budgets         | `src/llm/streamWatchdog.ts`                  |
| Local-server stall probe (/slots, /v1/status; loopback only) | `src/llm/stallProbe.ts` |
| Local llama.cpp fetch (30 min headers wait)  | `src/llm/localLlamaFetch.ts`                 |
| Cut-off tool call: type + classification     | `src/llm/ToolCallTruncatedError.ts`          |
| No-projector backend error classification    | `src/llm/imageUnsupportedError.ts`           |
| Live per-request output budget tracking, and the re-export facade every consumer still imports from | `src/util/contextBudget.ts` |
| Token estimation for prompts and tool results (`CHARS_PER_TOKEN`, `estimateTokens`, `estimateContextParts`) | `src/util/tokenEstimate.ts` |
| llama.cpp context and KV sizing (`spawnArgs`, `kvUnified`, `perSlotContext`, `reasoningReserve`) | `src/util/llamaContextBudget.ts` |
| Token-count display formatting               | `src/util/formatTokens.ts`                   |
| Elapsed-duration display formatting          | `src/util/formatDuration.ts`                 |
| Local date + wall clock for the model        | `src/util/localClock.ts`                     |
| Abortable sleep (listener removed either way) | `src/util/abortableSleep.ts`                |
| Remote compaction notice policy              | `src/remote/remoteCompactionNotice.ts`       |
| Host activity event shape                    | `src/sidebar/HostActivity.ts`                |
| Finished-turn mirroring to remote chats      | `src/sidebar/turnMirrorWiring.ts`            |
| Streaming Ollama native client               | `src/llm/OllamaNativeClient.ts`              |
| Ollama response-frame schema, safe body and usage normalization | `src/llm/ollamaResponse.ts` |
| Request normalization (per-provider)         | `src/llm/RequestNormalizer.ts`               |
| llama-server media-marker neutralization     | `src/llm/mediaMarkerGuard.ts`                |
| Sampling parameter merge                     | `src/llm/SamplingMerge.ts`                   |
| System-prompt injection                      | `src/llm/SystemPromptInjector.ts`            |
| Nunjucks template engine                     | `src/llm/TemplateEngine.ts`                  |
| Thinking/channel tag stripper                | `src/llm/ThinkingChannelStripper.ts`         |
| HTML boilerplate stripper                    | `src/llm/HtmlDocumentBoilerplateStripper.ts` |

## Tools

| Concern                                    | Owner                                 |
| ------------------------------------------ | ------------------------------------- |
| Tool dispatch + capability/permission gate | `src/tools/ToolRegistry.ts`           |
| The wording a refused tool call gets back (missing field, bad shape, schema refusal) | `src/tools/toolErrorText.ts` |
| Per-model tool output limits               | `src/tools/toolOutputLimits.ts`        |
| `read_tool_result` tool (re-read a capped tool result or past message by id, query or index) | `src/tools/toolResultTools.ts` |
| search_code capped result rendering        | `src/tools/searchCodeOutput.ts`        |
| Config-to-tool permission resolution       | `src/tools/PermissionResolver.ts`     |
| Tool registration entry point              | `src/tools/registerAllTools.ts`       |
| Tool-audit registry snapshot              | `scripts/tool-audit-registry.ts`       |
| Built-in tools + active-editor access      | `src/tools/builtinTools.ts`           |
| File reads, single and multi-range         | `src/tools/readFileTool.ts`          |
| read_file size and line-range guards (50 MiB cap, batch cap, range validation) | `src/tools/readFileGuards.ts` |
| read_file's one-range read of one file (binary refusal, document pages, line slicing) | `src/tools/readFileRange.ts` |
| Document extension dispatch + Telegram PDF text facade | `src/documents/index.ts` |
| PDF text extraction per page | `src/documents/pdf.ts` |
| DOCX text, headings and tables | `src/documents/docx.ts` |
| XLSX sheets, shared strings and formulas | `src/documents/xlsx.ts` |
| PPTX slides and speaker notes | `src/documents/pptx.ts` |
| ZIP central-directory validation and XML helpers | `src/documents/zipXml.ts` |
| PDF page rendering for `view_image` | `src/documents/pdfRenderer.ts` |
| PDF printing for `export_document` | `src/documents/pdfExport.ts` |
| Host-side Markdown to styled HTML | `src/documents/markdownToHtml.ts` |
| Markdown document structure to DOCX | `src/documents/docxFromMarkdown.ts` |
| Truncation-recovery write ceiling           | `src/tools/writeChunking.ts`          |
| File read/write tools                      | `src/tools/fileEditTools.ts`          |
| Shared workspace file delivery validation  | `src/util/fileDeliveryValidation.ts` |
| `send_file` tool                           | `src/tools/sendFileTool.ts`           |
| `edit_file` tool                           | `src/tools/editFileTool.ts`           |
| `write_file` line-ending selection and result note | `src/tools/writeEol.ts`       |
| `old_str` matching + line-ending handling + uniform indent shift | `src/tools/editMatch.ts`              |
| Structured line-edit validation + tool     | `src/tools/structuredEditTool.ts`     |
| Line-edit refusal texts (stale/moved/repeated) | `src/tools/structuredEditRefusals.ts` |
| Trailing-whitespace repair of path arguments (`path`, `paths`, `cwd`) | `src/tools/pathArgTrim.ts` |
| The file-length line a write result carries, and how its globs match | `src/tools/fileLengthWarning.ts` |
| The "new problems after this edit" note a write result carries: before/after snapshot, settle wait, diff | `src/tools/editDiagnostics.ts` |
| The VS Code-backed diagnostics source that note reads: the open that primes a closed file, the event, the workspace roots it will open inside | `src/tools/editDiagnosticsSource.ts` |
| The sentences that note falls back on when no check happened: not checked, nothing reported (with the reason a file was not opened), the time clause | `src/tools/editDiagnosticsNotes.ts` |
| Code + file search tools (ripgrep)         | `src/tools/dirTools.ts`               |
| `search_code`: what a result says + the secret gate | `src/tools/searchCodeTool.ts` |
| `search_code`: the ripgrep crawl, its argv and its page limit | `src/tools/searchCodeCrawl.ts` |
| Which paths are secrets, and how a path is matched | `src/tools/secretPaths.ts`       |
| Which paths the agent may not change (Forge's own files, and `config.yaml` only while its security settings are still inside it) | `src/tools/ownerPaths.ts` |
| Which shell argument positions are reads, not writes (interpreters, `cp`/`Copy-Item`, inline `--target=`) | `src/tools/shellWritePositions.ts` |
| Which hosts a chat may reach (a fetch, its redirects, a preview page's scripts), and what a fetch asks for | `src/tools/fetchHostApprovals.ts` |
| Search scope: excludes + named-path rule   | `src/tools/searchScope.ts`            |
| search_code snippet/result size bounds     | `src/tools/searchSnippet.ts`          |
| list_directory + size/age formatting       | `src/tools/listDirectoryTool.ts`      |
| `shell` tool (spawn, approval, background)  | `src/tools/shellTool.ts`              |
| Shell call classification cache and attended Clanker refusal release | `src/tools/shellToolCallGate.ts` |
| Shell `timeout_ms` hint text and argument check | `src/tools/shellToolTimeout.ts` |
| Background-execution registry (~/.forge/background-execs/, reaped after a killed host) | `src/tools/backgroundRegistry.ts` |
| Shell command classification (read-only/normal/dangerous/refused) | `src/tools/shellPolicy.ts` |
| Shell scripts read and added to command classification | `src/tools/shellScriptFiles.ts` |
| Which token lists are read-only invocations (the program table + argument checks) | `src/tools/shellReadOnlyRules.ts` |
| Shell program names and Git global-option tokens | `src/tools/shellCommandTokens.ts` |
| The shell command-line parser: statements, separators, redirection targets, what can still be a read | `src/tools/shellCommandParse.ts` |
| Bash heredoc bodies split out before shell classification | `src/tools/shellHeredoc.ts` |
| Shell/git output cap + spill files          | `src/tools/shellOutput.ts`            |
| Exec child-process helpers                 | `src/tools/execHelpers.ts`            |
| Git Bash / program resolution              | `src/tools/execProgramResolver.ts`    |
| Strict JSON input parsing for tool arguments and session views | `src/tools/jsonInput.ts` |
| Windows Restart Manager file-holder lookup | `src/util/windowsFileHolders.ts` |
| Git tools (status, diff, commit)           | `src/tools/gitTools.ts`               |
| Strict `git_read` operation schema/dispatch | `src/tools/gitReadTool.ts`           |
| Git read-operation handlers                 | `src/tools/gitReadTools.ts`          |
| Notebook read/edit tools                    | `src/tools/notebookTools.ts`         |
| Git handle, execution, status parsing      | `src/tools/gitRepo.ts`                |
| Git repository discovery + selection       | `src/tools/gitDiscovery.ts`           |
| Git tracked/ignored state of a path        | `src/tools/gitTrackedStatus.ts`       |
| git log argv, framing and parsing          | `src/tools/gitLog.ts`                 |
| Search provider requests and result formatting (DuckDuckGo / Tavily) | `src/tools/searchTool.ts` |
| DuckDuckGo HTML result extraction and anomaly detection | `src/tools/searchToolDuckDuckGo.ts` |
| HTML to plain text for fetched web pages                | `src/util/htmlText.ts` |
| URL fetch tool: redirects, response limits and tool wiring — the guard itself is owned by the row below | `src/tools/fetchTool.ts` |
| SSRF primitives + pinned-agent factory shared by `web_fetch` and the render-html preview | `src/tools/webFetchSsrf.ts` |
| Bounded streamed response text reader (shared web and jobs fetch) | `src/util/readTextCapped.ts` |
| LSP provider handlers dispatched by `code_intel`, and the `path:line: severity code: message` spelling both diagnostics readers share | `src/tools/lspTools.ts` |
| LSP location and symbol-result formatting | `src/tools/lspFormat.ts` |
| Workspace memory files, frontmatter, migration, and index | `src/memory/memoryStore.ts` |
| Workspace memory tool schemas and handlers | `src/tools/memoryTools.ts`            |
| UX tools (show_diff, open_file)            | `src/tools/uxTools.ts`                |
| Clipboard tools (copy/read_clipboard)      | `src/tools/clipboardTools.ts`         |
| Power tools (sleep, wake timer, WoL info)  | `src/tools/powerTools.ts`             |
| Denylist (dangerous command filter)        | `src/tools/DenyList.ts`               |
| Shell command-string extraction and control statement normalization | `src/tools/shellCommandStrings.ts` |
| User confirmation request + response flow  | `src/sidebar/ToolApprovalService.ts`  |
| Tool strip (remove tools from request)     | `src/tools/StripTools.ts`             |
| Structured output / fallback tool parser   | `src/tools/StructuredOutputParser.ts` |
| Tool call JSON-fence fallback converter    | `src/tools/ToolCallFallback.ts`       |
| Fallback tool-format prompt instructions   | `src/tools/FallbackToolPrompt.ts`     |
| `get_system_status` tool                   | `src/tools/systemStatusTool.ts`       |
| Semantic codebase search tool              | `src/tools/semanticSearchTool.ts`     |
| MCP client bridge (external MCP servers)   | `src/tools/mcpBridge.ts`              |
| Demand-loaded native and MCP tool groups  | `src/tools/lazyToolGroups.ts`         |
| `load_tool_group` discovery tool           | `src/tools/toolGroupTools.ts`         |
| Static native lazy group names             | `src/config/toolGroupNames.ts`        |
| Tool-result size capping                   | `src/tools/resultCap.ts`              |
| Bundled ripgrep executable resolution      | `src/tools/RipgrepResolver.ts`        |
| Language-server project priming and identifier text search | `src/tools/symbolSearch.ts` |
| Local agent delegation tool                | `src/tools/localAgentTool.ts`         |
| `list_delegation_targets` + target ranking | `src/tools/localAgentTool.ts`         |
| Delegation target VRAM classification      | `src/delegation/eligibility.ts`       |
| Per-turn tool allowlist + call-budget      | `src/tools/ToolBudget.ts`             |
| Plan rendering + `isPlanFinished` + `PLAN_GUIDANCE` | `src/tools/planTools.ts`              |
| `view_image` tool                          | `src/tools/imageTool.ts`              |
| `export_document` tool (source/output validation and checkpointed write) | `src/tools/exportDocumentTool.ts` |
| `send_file` tool (workspace + screenshot-dir delivery) | `src/tools/sendFileTool.ts` |
| `render_html_to_image` tool (schema, mode dispatch, image-mode naming and delivery) | `src/tools/renderHtmlToImageTool.ts` |
| Shared render-browser launch hardening, abort/timeout cleanup and preview origin | `src/tools/renderHtml/renderBrowser.ts` |
| Inert HTML→PNG rendering and full-page height cap | `src/tools/renderHtml/renderEngine.ts` |
| Interactive HTML preview (guarded request routing, frame capture and page diagnostics) | `src/tools/renderHtml/previewRenderer.ts` |
| Preview resource transport (host-side fetch of routed requests, redirects re-checked per hop, byte cap) | `src/tools/renderHtml/previewFetch.ts` |
| `render_html_to_image` input validation (HTML size cap, workspace file read, viewport bounds) | `src/tools/renderHtml/htmlInput.ts` |
| `render_html_to_image` preview mode (result text, vision-gated image part; saves and sends nothing) | `src/tools/renderHtml/previewMode.ts` |
| Shader discovery in workspace files (WGSL/GLSL files, typed script blocks, string literals; source-line mapping) | `src/tools/renderHtml/shaderExtract.ts` |
| `render_html_to_image` shader_check mode (isolated software-adapter compile, diagnostics with file locations) | `src/tools/renderHtml/shaderCheck.ts` |
| Code-point length counting (schema/Telegram char limits) | `src/util/codePoints.ts` |
| `generate_image` tool + save/deliver       | `src/tools/imageGeneration/generateImageTool.ts` |
| Cloud `/v1/images/generations` backend     | `src/tools/imageGeneration/cloudImageBackend.ts` |
| Local `/sdapi/v1/txt2img` backend          | `src/tools/imageGeneration/sdcppImageBackend.ts` |
| VRAM gate shared by local generation and `upscale_image` | `src/tools/imageGeneration/sdcppVramGate.ts` |
| Media GPU lease protocol shared with private media skills | `src/media/mediaGpuLease.ts` |
| `media:` configuration schema                  | `src/config/mediaSchema.ts`            |
| Media setup report (sidebar and Telegram)    | `src/media/mediaSetupCheck.ts`          |
| `generate_video` tool                       | `src/tools/media/generateVideoTool.ts`  |
| `generate_music` tool                       | `src/tools/media/generateMusicTool.ts`  |
| Media source-file copies and accepted audio extensions | `src/tools/media/mediaInputFiles.ts` |
| Telegram media previews and workspace-relative paths | `src/tools/media/mediaDelivery.ts` |
| `image_generation:` config schema          | `src/config/imageGenerationSchema.ts` |
| `upscale_image` tool (input cap, VRAM gate, one-shot `sd-cli` pass, `_x4.png` naming/delivery) | `src/tools/imageGeneration/upscaleImageTool.ts` |
| `image_generation.upscale:` config schema   | `src/config/imageUpscaleSchema.ts` |
| `image_search` tool + attachment pick       | `src/tools/imageSearch/imageSearchTool.ts` |
| SerpApi Google Lens call + result trimming | `src/tools/imageSearch/serpApiLens.ts` |
| Litterbox temporary image upload           | `src/tools/imageSearch/litterboxUpload.ts` |
| Search thumbnail pick/download/prune       | `src/tools/imageSearch/imageThumbnails.ts` |
| SerpApi transport + error surfacing        | `src/tools/imageSearch/serpApi.ts`    |
| SerpApi Yandex Images call + formatting    | `src/tools/imageSearch/yandexImages.ts` |
| `image_search:` config schema              | `src/config/imageSearchSchema.ts` |
| Tool image thumbnail URLs: workspace + screenshots (webview) | `webview-ui/src/workspaceRootUri.ts` |
| `view_video` tool definition + handler     | `src/tools/videoTool.ts`              |
| ffmpeg probe + frame extraction            | `src/tools/videoExtract.ts`           |
| ffmpeg/ffprobe executable discovery        | `src/tools/ffmpegLocate.ts`           |
| Browser session lifecycle (system channel, lazy playwright-core) | `src/tools/browser/BrowserSessionManager.ts` |
| Browser input-action guards (coordinate bounds, locator timeout, failure naming) | `src/tools/browser/browserActionGuards.ts` |
| Browser text-input mode for an inspected node (fill vs dropdown option) | `src/tools/browser/browserTextInput.ts` |
| Screenshot root, per-chat capture folder, `FORGE_SCREENSHOT_DIR` override, delete-with-owner | `src/tools/browser/screenshotPaths.ts` |
| Desktop driver contract (SendInput/GDI impl lands Phase 2) | `src/tools/desktop/DesktopDriver.ts` |
| Desktop tool approval predicates (window-capture binding, cloud monitor gate, system chords, consequential) | `src/tools/desktop/desktopApprovals.ts` |
| Desktop B2 target-window gate (refused windows, foreground + rect check, `allow_vscode` revocation) | `src/tools/desktop/targetWindowGate.ts` |
| Desktop driver wrapper (approval binding, coordinate transform, identity) | `src/tools/desktop/PowerShellDesktopDriver.ts` |
| Desktop driver process transport (spawn/fallback, per-request timeout, respawn, release-all backstop) | `src/tools/desktop/PowerShellTransport.ts` |

## Skills

| Concern                                              | Owner                                    |
| ---------------------------------------------------- | ---------------------------------------- |
| Skill roots, folder walk, `SKILL.md` frontmatter parse, later-root-wins shadowing, symlink containment, skip-with-reason | `src/skills/discover.ts` |
| "Is this resolved path inside that resolved folder" (the check a symlink has to pass) | `src/skills/paths.ts` |
| Reading one skill out for `load_skill`: body, script and reference real paths, `config.json` never read | `src/skills/loadSkill.ts` |
| Catalog text: header (the trust rule), one line per skill, 4,000-char cap and the count it cut | `src/skills/catalog.ts` |
| The three roots as a live object, the per-conversation frozen catalog, and the once-per-root-set skip log | `src/skills/skillsService.ts` |
| Building the skills service for an activation (its getters, and its log line) | `src/skills/createSkillsService.ts` |
| `load_skill` schema and tool handoff (eager, ungrouped, `skills:` is the gate) | `src/tools/loadSkillTool.ts` |
| The skills catalog template (layout only; the header and line format come from `catalog.ts`) | `config/templates/builtin/skills.njk` |
| Shipped skills, and the `.vscodeignore` exceptions that keep `SKILL.md` in the VSIX | `resources/skills/` and `.vscodeignore` |
| The skills catalog reaching a prompt: provider set on the engine, read once per turn | `src/llm/TemplateEngine.ts` (wired in `src/extension.ts`, read in `ModelTurn.ts` / `PromptRun.ts`) |

## Semantic Search

| Concern                                  | Owner                            |
| ---------------------------------------- | -------------------------------- |
| Index build/update + query orchestration | `src/search/IndexManager.ts`     |
| Embedding HTTP client (/v1/embeddings)   | `src/search/EmbeddingClient.ts`  |
| Exact token count (/tokenize)            | `src/search/TokenCounter.ts`     |
| Embedding token budget + byte bound      | `src/search/embeddingBudget.ts`  |
| Embedding task-prefix formatting         | `src/search/embeddingPrompts.ts` |
| File chunking + chunk hashing            | `src/search/chunking.ts`         |
| Vector math (cosine similarity)          | `src/search/semanticMath.ts`     |
| Search index types                       | `src/search/types.ts`            |

## Config

| Concern                                                 | Owner                                |
| ------------------------------------------------------- | ------------------------------------ |
| `config.yaml` schema (Zod)                              | `src/config/schema.ts`               |
| Model config schema (model/profile/active/group field)  | `src/config/modelSchema.ts`          |
| Remote config schema (queue/auth/attachments/aliases)   | `src/config/remoteSchema.ts`         |
| Shared Zod primitives (groups/spawn/sampling)           | `src/config/schemaShared.ts`         |
| `tools:` block schema (file-length warning, `edit_diagnostics`) and the `skills:` block | `src/config/toolsSchema.ts` |
| Config load + validation                                | `src/config/ConfigLoader.ts`         |
| `~/.forge/policy.yaml` schema (the owner's policy file) | `src/config/policySchema.ts`         |
| Policy file read + "one key, one file" rule             | `src/config/PolicyLoader.ts`         |
| Phase 3 enforcement: policy keys, program names and unapproved hosts config.yaml may no longer hold | `src/config/PolicyLoader.ts` |
| `Forge: Lock policy.yaml` / `Unlock policy.yaml` — the lock state, read back from the file | `src/config/policyLock.ts` |
| The card rule: which call leaves the machine, which chat is flagged, and the refusal wording per flag | `src/sidebar/untrustedExitPolicy.ts` |
| Both chat flags (a secret read, outside content) and the transcript re-derivation that fails CLOSED | `src/tools/exfilTaint.ts` |
| The tool contract: what a registered tool declares (`untrustedResult`, `reachesOut`, `cardTextOnly`, `approvalKey`) | `src/tools/toolContract.ts` |
| Which shell command reaches a host (`networkReaching`, additive to the classification) | `src/tools/shellPolicy.ts` |
| The approval key: what a gated call has to be allowed to do, and the fail-closed rule that leaves it unkeyable | `src/sidebar/approvalKey.ts` |
| The key grammar: how a path compares, what a rule is allowed to name, whether a rule covers a requirement | `src/sidebar/approvalKeyGrammar.ts` |
| Human-readable names for approval keys | `src/sidebar/approvalKeyWords.ts` |
| The chat's approval rules: what may be stored, the fetch-store split for `net:`, and what clears them | `src/sidebar/chatApprovalRules.ts` |
| Chat approval write result and owner-facing message | `src/sidebar/approvalChatWriter.ts` |
| Owner policy approval matching, unattended allow lists and `/approvals` policy rows | `src/sidebar/approvalPolicyRules.ts` |
| Current-window policy rules after an owner click | `src/sidebar/approvalPolicySession.ts` |
| “Always in this project” write and locked-policy behavior | `src/sidebar/approvalProjectWriter.ts` |
| Where a chat's Clanker flag lives (its record), the pair the queue reads and writes, and what `/clear` clears | `src/sidebar/chatClanker.ts` |
| Which program a shell statement reaches a host through, and the key name it gets | `src/tools/shellNetworkPrograms.ts` |
| Which arguments of a shell command read a secret file, and whether one file can be named | `src/tools/shellSecretReads.ts` |
| Approval card timeout state, kept apart from the queue | `src/sidebar/approvalTimeoutState.ts` |
| Closing the tool calls a reload left running | `src/sidebar/interruptedToolCalls.ts` |
| `engines`/`model_hosts` schema (programs Forge runs, and the `gpus` a server occupies) | `src/config/engineSchema.ts` |
| Policy migration YAML node utilities (vscode-free)      | `src/config/policyYamlNodes.ts`      |
| `Forge: Move security settings to policy.yaml`          | `src/config/policyMigration.ts`      |
| Policy-key write routing (which file holds the key)     | `src/config/ConfigWriter.ts`         |
| Model references: which config fields name a model      | `src/config/modelReferences.ts`      |
| Post-schema cross-block checks (loader + writer)        | `src/config/configChecks.ts`         |
| Two-flavor model/profile/alias resolver                 | `src/config/ConfigResolver.ts`       |
| Config + model types                                    | `src/config/types.ts`                |
| Config types: model/group/profile entries               | `src/config/modelTypes.ts`           |
| Image, video, music and voice configuration types        | `src/config/mediaTypes.ts`           |
| Comment-preserving config writer (entry point)          | `src/config/ConfigWriter.ts`         |
| YAML Document mutation helpers (set/add/remove)         | `src/config/ConfigWriterHelpers.ts`  |
| Groups migration orchestration + resolved-diff verifier | `src/config/ConfigMigrator.ts`       |
| Groups migration clustering/lifting heuristic           | `src/config/ConfigGroupHeuristic.ts` |
| Schema-valid starter config generation                  | `src/config/StarterConfig.ts`        |
| User-facing config example                              | `config/config.example.yaml`         |

## VS Code Integration

| Concern                              | Owner                            |
| ------------------------------------ | -------------------------------- |
| Status bar (backend state indicator) | `src/vscode/BackendStatusBar.ts` |
| Native VS Code commands              | `src/vscode/nativeCommands.ts`   |
| `Forge: Check Media Setup`            | `src/vscode/mediaCommands.ts`    |
| Stale build: window vs installed    | `src/vscode/staleBuild.ts`        |
| Editor-context commands              | `src/vscode/editorCommands.ts`   |
| Command behaviour (prefill, run)     | `src/vscode/commandHelpers.ts`   |
| Shared command dependency type       | `src/vscode/commandDeps.ts`      |
| Checkpoint settings -> stack         | `src/vscode/checkpointSetup.ts`  |
| Activation Keep/Undo editor registrations | `src/vscode/keepUndoSetup.ts` |
| Tool services, registry and MCP activation setup | `src/vscode/toolActivationSetup.ts` |
| Extension command and file code-action activation registrations | `src/vscode/commandRegistrationSetup.ts` |
| config.yaml hot-reload               | `src/vscode/configReload.ts`     |
| SecretStorage setup commands         | `src/vscode/secretCommands.ts`   |
| Model-control palette commands       | `src/vscode/controlCommands.ts`  |
| Code action provider (quick fixes)   | `src/vscode/codeActions.ts`      |
| Editor context collector             | `src/vscode/editorContext.ts`    |
| Scratch document (markdown preview)  | `src/vscode/scratchDocuments.ts` |
| Sidebar/panel + Keep/Undo commands   | `src/vscode/sidebarCommands.ts`  |
| Config bootstrap (first load, setup fallback) | `src/vscode/configBootstrap.ts` |
| Remote runtime setup (channels, config setters, wake relay) | `src/vscode/remoteRuntimeSetup.ts` |
| Shared VS Code window reload command (Telegram and agent bus) | `src/vscode/windowReload.ts` |
| Which VS Code remote kinds mean this window is hosted on another computer's behalf (`tunnel`, `ssh-remote`) | `src/vscode/remoteWindowKind.ts` |
| Workspace bootstrap (session migration, FORGE.md, the agent note, the four desktop-bridge commands) | `src/vscode/workspaceBootstrap.ts` |
| Index file watchers (save/create/delete/rename) | `src/vscode/indexWatchers.ts` |

## Checkpoints

| Concern                                        | Owner                                     |
| ---------------------------------------------- | ----------------------------------------- |
| Per-turn checkpoint stack (public entry point) | `src/checkpoint/CheckpointStack.ts`       |
| Undo-history depth cap + review snapshots      | `src/checkpoint/checkpointHistory.ts`     |
| Disk-backed capture + commit                   | `src/checkpoint/DiskCheckpointStore.ts`   |
| Disk-backed restore + discard                  | `src/checkpoint/DiskCheckpointRestore.ts` |
| In-memory snapshot capture/restore             | `src/checkpoint/MemoryCheckpointState.ts` |
| Workspace/paths inventory walk                 | `src/checkpoint/CheckpointInventory.ts`   |
| On-disk manifest schema + versioning           | `src/checkpoint/CheckpointManifest.ts`    |
| Change detection + inventory comparison        | `src/checkpoint/CheckpointDiff.ts`        |
| Size/count limits + free-space assertions      | `src/checkpoint/CheckpointPolicy.ts`      |
| Atomic writes, hashing, abort checks           | `src/checkpoint/CheckpointFileIO.ts`      |
| Leftover-checkpoint reporting on startup       | `src/checkpoint/CheckpointRecovery.ts`    |

## Voice (STT/TTS transport — plan: `docs/VOICE_STT_TTS_IMPLEMENTATION_PLAN.md`)

| Concern                                          | Owner                                  |
| ------------------------------------------------ | -------------------------------------- |
| Voice transport types + `WhisperRunner` contract | `src/voice/VoiceTypes.ts`              |
| Temp-audio ownership + disposal                  | `src/voice/VoiceOperation.ts`          |
| Audio -> 16 kHz mono WAV + silence trim          | `src/voice/AudioNormalizer.ts`         |
| Normalize -> transcribe -> admission rule        | `src/voice/VoiceIngress.ts`            |
| Transcript acceptance, refusal + echo filters    | `src/voice/TranscriptAcceptance.ts`    |
| Unconfirmed transcript state machine             | `src/voice/PendingVoiceDraft.ts`       |
| Spoken command grammar + gate correlation        | `src/voice/VoiceGrammar.ts`            |
| Voice session-log events                         | `src/voice/VoiceAudit.ts`              |
| Voice audit JSONL writer                         | `src/voice/VoiceAuditFileSink.ts`      |
| Tier A STT test double                           | `src/voice/FakeWhisperRunner.ts`       |
| Spoken pronunciation of technical tokens         | `src/voice/SpeechLexicon.ts`           |
| Pronunciation lexicon data                       | `src/voice/lexicon.json`               |
| whisper.cpp process + argv                       | `src/voice/WhisperCppRunner.ts`        |
| Piper process + argv                             | `src/voice/PiperRunner.ts`             |
| Markdown -> speakable text                       | `src/voice/SpeechRenderer.ts`          |
| Spoken reply delivery                            | `src/remote/RemoteSpeechDelivery.ts`   |
| Telegram voice note -> draft -> prompt           | `src/remote/RemoteVoiceBridge.ts`      |
| Voice config-to-bridge assembly and draft wiring | `src/remote/remoteVoiceWiring.ts`      |
| Bot API update -> `RemoteInboundEvent`           | `src/remote/TelegramInboundMapping.ts` |

ffmpeg discovery is NOT owned here — it stays `src/tools/ffmpegLocate.ts`, and
the configured override stays the existing `video.ffmpeg_path` key.

## Machine report (`/system`)

| Concern                                    | Owner                              |
| ------------------------------------------ | ---------------------------------- |
| Machine report struct + collection         | `src/system/SystemReport.ts`       |
| nvidia-smi / WDDM counter probes + parsers | `src/system/systemProbes.ts`       |
| Report rendering (sidebar/Telegram/tool)   | `src/system/formatSystemReport.ts` |
| Suspend + wake-timer commands (sole spawn) | `src/system/PowerControl.ts`       |
| Wake config parsing + report formatting    | `src/system/wakeInfo.ts`           |

## Persistent agent jobs (the 2026-09-14 plan is local history, not in the repo)

| Concern                                                    | Owner                                                          |
| ---------------------------------------------------------- | -------------------------------------------------------------- |
| Stale owner job approval policy warning | `src/jobs/approvalJobRuleWarnings.ts` |
| Job definition + state + run-log store (disk layout)       | `src/jobs/JobStore.ts`                                         |
| Stable job-name slug and unique job-id generation          | `src/jobs/jobId.ts`                                            |
| Job schema (Zod) + state / run-row types                   | `src/jobs/jobSchema.ts`                                        |
| Schedule math (`nextDue`, `isDue`, `wakeTimesFor`)         | `src/jobs/schedule.ts`                                         |
| Tick loop, lease, concurrency                               | `src/jobs/JobScheduler.ts`                                     |
| Single admitted model-job lane + pending admission ordering | `src/jobs/jobModelLane.ts`                                     |
| Scheduler lease acquisition (FileLease + wake reset)        | `src/jobs/jobLease.ts`                                         |
| Per-job run leaves: check, backoff, sleep-if-idle           | `src/jobs/jobRunLifecycle.ts`                                  |
| Failure threshold and next-due backoff math                 | `src/jobs/backoff.ts`                                          |
| CLI-agent consent gate for jobs (`jobs.allow_cli_agents`)  | `src/jobs/cliAgentGate.ts`                                     |
| Wake-task ownership (dedupe, lease-guarded delete)         | `src/jobs/schedulerWakes.ts`                                   |
| Home-window match (`jobs.home_workspace`) + non-home note  | `src/jobs/jobsHome.ts`                                         |
| Outbox write, local toast, summarize-waits-for-idle        | `src/jobs/JobDelivery.ts`                                      |
| Coalescing outbox (one pending message per job)            | `src/jobs/JobOutbox.ts`                                        |
| Gated jobs network fetch (release API, binary download)    | `src/jobs/jobsFetch.ts`                                        |
| Check kinds (github_release, github_issue, hf_discussion, disk_space, none) | `src/jobs/checks/github.ts`, `src/jobs/checks/huggingface.ts`, `src/jobs/checks/diskSpace.ts`  |
| Check kind tool_usage (writes the daily tool-usage files, never notifies) | `src/jobs/checks/toolUsage.ts` |
| Check dispatch + check context                             | `src/jobs/checks/runCheck.ts`                                |
| Check context + result types                               | `src/jobs/checks/checkTypes.ts`                                |
| Human-readable job description (for `/jobs`)               | `src/jobs/jobDescribe.ts`                                      |
| `manage_jobs` create confirmation text (enabled/disabled, agent model) | `src/jobs/jobCreateText.ts` |
| `manage_jobs` tool (create/update/pause/delete)            | `src/tools/jobTools.ts`                                        |
| Job reference resolution (exact id/name, then substring) shared by `manage_jobs` and `/job` | `src/jobs/jobRefResolver.ts` |
| Discuss chat seeding (`manage_jobs` + `/job chat`)         | `src/jobs/jobDiscuss.ts`                                       |
| `agent_task` runner (unattended agent turn)                 | `src/jobs/agentTask.ts`                                        |
| Sessions panel Jobs tab: what the store says, as one snapshot | `src/jobs/jobPanelSnapshot.ts` (push bridge: `src/sidebar/jobPanelUpdates.ts`) |
| Agent task prompt and final result parsing                  | `src/jobs/agentTaskPrompt.ts`                                  |
| `agent_task` durable run state (config backup path, crash recovery) | `src/jobs/agentTaskState.ts`                                   |
| `agent_task` step 7 (restart after turn, config rollback)          | `src/jobs/agentTaskRestart.ts`                                   |
| `agent_task` admission (slot check, busy/TTL defer)                | `src/jobs/agentTaskAdmission.ts`                                 |
| Local-GPU agent-task admission gate (hold file + sampled probe)  | `src/jobs/gpuIdleGate.ts`                                     |
| `agent_task` max_minutes cap (send + cancel race)                  | `src/jobs/agentTaskCap.ts`                                       |
| `retitle` action: which chats may be renamed (pure filter)          | `src/jobs/retitleCandidates.ts`                                  |
| `retitle` action: reading this workspace's chats off disk            | `src/jobs/retitleRecords.ts`                                     |
| `retitle` action: gates, model ask, host apply, run row             | `src/jobs/retitleRun.ts`                                          |
| `agent_task` report (outcome mapping, report text)                 | `src/jobs/agentTaskReport.ts`                                    |
| A stopped run the owner closed by finishing it in the job's chat    | `src/jobs/resumedRun.ts` (wired at `src/sidebar/sidebarWiring.ts`) |
| `llamacpp_update` action (stages 6-8, switch, rollback)    | `src/jobs/actions/llamacppUpdate.ts`                           |
| llama.cpp install pipeline (download, verify, smoke test)  | `src/jobs/actions/llamacppInstall.ts`                          |
| Scheduler-facing llamacpp action wrapper + busy gate       | `src/jobs/actions/llamacppAction.ts`                           |
| Staged build metadata + 24 h TTL                           | `src/jobs/actions/stagedBuild.ts`                              |
| llamacpp IO (sha256, extractZip, runCommand, setBinary)    | `src/jobs/actions/llamacppIo.ts`                               |
| Production jobs wiring (home-window gate, scheduler + action deps) | `src/vscode/jobsSetup.ts`                              |
| Telegram `/jobs` + `/job <n>` commands                     | `src/remote/RemoteJobCommands.ts`                              |
| Outbox watcher (drains the outbox to the owner chat)       | `src/remote/JobOutboxWatcher.ts`                               |
| Agent-bus files (ids, wait, replies, orphans, TTL)         | `src/agentBus/agentBus.ts`                                     |
| Agent-bus shipped text (README, message bodies)            | `src/agentBus/busContent.ts`                                   |
| Workspace agent note (the marked `AGENTS.md` / `CLAUDE.md` section: text, markers, writer) | `src/agentBus/agentMeshNote.ts` |
| Which file the agent note goes into, the one-time disclosure, `forge.agentMesh.installNote` | `src/vscode/agentMeshNoteSetup.ts` |
| Agent-bus client script (`~/.forge/agent-bus/forge.sh`)    | `src/agentBus/forge.sh` (bundled as text by busContent.ts)     |
| Claude session registry + peer-pipe delivery               | `src/agentBus/claudePeer.ts`                                   |
| One-shot Claude Code session reopen across a VS Code window reload | `src/agentBus/claudeReopen.ts`                                  |
| Claude delivery via a `claude -p` relay (opt-in)           | `src/agentBus/claudeRelay.ts`                                  |
| Inbound agent messages → Forge turns (queue)               | `src/agentBus/agentInbox.ts`                                   |
| Inbound queue mid-turn eligibility, release + arrival listeners | `src/agentBus/agentInboxMidTurn.ts`                          |
| Inbound queue scan serialization and rescan scheduling      | `src/agentBus/agentInboxScanScheduler.ts`                     |
| Which chat an inbound bus message lands in (sender affinity) | `src/agentBus/busTarget.ts`                                    |
| Plain-text bus status, queue and transcript answers      | `src/agentBus/busStatusView.ts`                                |
| `/agent/message` + `/agent/reply` routes, endpoint.json    | `src/backend/agentRoutes.ts`                                   |
| `/agent/who?format=text` participant field projection       | `src/backend/agentWhoText.ts`                                   |
| `GET /agent/status` + `GET /agent/view` — read the sender's own chat, or one linked to its session | `src/backend/agentChatReadRoute.ts` |
| `GET /agent/chats` + `GET /agent/peer-view` — what one window answers to another, on the bus token alone | `src/backend/agentChatReadRoute.ts` |
| Which `/agent/*` paths a window serves (the 404 gate)          | `src/backend/agentKnownRoutes.ts`                              |
| Authenticated `/agent/send-file` route                    | `src/backend/agentFileRoute.ts`                                |
| Agent-route request body parsing                           | `src/backend/agentRouteFields.ts`                              |
| `/agent/reply` route — the answer to a question still waited on | `src/backend/agentReplyRoute.ts`                        |
| Agent-messaging activation wiring (inbox, turn watch, disposal)  | `src/vscode/agentMessagingSetup.ts`                            |
| Which routes a window registers and what each does (`buildAgentRouteDeps`) | `src/vscode/agentRouteDeps.ts`                    |
| Agent-bus chat targeting, steer/stop resolution, model ids       | `src/vscode/agentBusSubmission.ts`                            |
| Agent-bus message submission (routes a bus message into its Forge chat) | `src/vscode/agentBusSubmission.ts` (shared owner with chat targeting) |
| Agent-bus delivery to an open Codex (`codex queue`)        | `src/agentBus/codexDelivery.ts`                                |
| `jobs:` config schema + agent_task model default and pin   | `src/config/jobsSchema.ts`                                     |
| `fetch:` config schema (`allowed_hosts`, the hosts a chat may reach without a card) | `src/config/fetchSchema.ts` |
| `agent_bus:` config schema                                 | `src/config/agentBusSchema.ts`                                 |
| `model_starter:` config schema (starter port, shared ports, lease TTL) | `src/config/modelStarterSchema.ts` |
| `cloud_relay:` config schema (port, body cap, desktop model allowlist) | `src/config/cloudRelaySchema.ts` |
| Live Claude session-id picker for `/link`                  | `src/vscode/agentBusCommands.ts`                               |

## Agent-bus exchange records

| Concern                                         | Owner                              |
| ----------------------------------------------- | ---------------------------------- |
| Host identity + process liveness                | `src/agentMesh/hostIdentity.ts`    |
| Exchange state transitions                      | `src/agentMesh/deliveryState.ts`  |
| Durable exchange event log and interprocess lock | `src/agentMesh/exchangeLog.ts`    |
| Exchange file lock                              | `src/agentMesh/lock.ts`           |
| Full verdict retention and acknowledgment        | `src/agentMesh/verdictArtifact.ts`|
| Codex thread liveness for a linked session       | `src/agentLinks/codexThreadLiveness.ts` |
| Authenticated verdict read/ack HTTP handlers     | `src/backend/agentVerdictRoute.ts`|

## Build / packaging

| Concern                                                    | Owner                                     |
| ---------------------------------------------------------- | ----------------------------------------- |
| Extension + webview bundles, webview asset copy            | `esbuild.config.mjs`                      |
| playwright-core ship (external + dist/node_modules copy)   | `esbuild.config.mjs` (`copyPlaywrightCore`) |
| Bundle load check (circular/TDZ + playwright-core resolve) | `scripts/bundle-load-check.js`            |
| VSIX contents allow-list check                             | `scripts/check-vsix-contents.mjs`          |
| One full `npm run ci` per machine (lock in os.tmpdir)       | `scripts/ci-lock.mjs`                      |
| Test temp containment: per-run folder + dead-run sweep     | `test/support/tempGuard.global.ts`        |
| Test temp leak check: per-file folder, fails a leaking file | `test/support/tempGuard.setup.ts`         |
| Hermetic fake `claude` executable for tests                | `test/support/fakeCli.ts`                 |
| Shared Telegram contact fixtures and completion signals    | `test/support/telegramContactFixture.ts`  |
| Shared model starter fixtures: fake pool, live loopback listener, request helper | `test/support/modelStarterHarness.ts` |

## Test support

| Concern                                | Owner                                  |
| -------------------------------------- | -------------------------------------- |
| Shared sdcpp backend config fixtures   | `test/support/sdServerFixtures.ts`     |
| Shared silent PCM WAV fixture          | `test/support/silentPcmWav.ts`         |
| Benchmark harness (arms, evaluator, orchestrator, report; `bench:smoke` / `bench:ping`) | `src/benchmark/orchestrator.ts` |

## Misc

| Concern                                     | Owner                         |
| ------------------------------------------- | ----------------------------- |
| Path containment test (vscode-free)         | `src/util/pathContainment.ts` |
| The drive fold `/n/x` → `N:/x` (vscode-free) | `src/util/drivePath.ts`       |
| The path API of the OS being judged, so a Windows-shaped path on a Linux runner is judged the Windows way (`pathApiFor`) | `src/util/drivePath.ts` |
| Real path of the nearest existing ancestor (8.3 names, junctions; sync) | `src/util/realPath.ts` |
| Spawn-and-collect child process (no vscode) | `src/util/processSpawn.ts`    |
| Streamed child-output head+tail cap         | `src/util/outputCap.ts`       |
| Workspace path resolution + realpath        | `src/util/WorkspacePaths.ts`  |
| Missing workspace path error (vscode-free)  | `src/util/workspacePathMissingError.ts` |
| Structured logging                          | `src/util/logger.ts`          |
| Error message + cause-chain description     | `src/util/describeError.ts`   |
| The "keys are per computer" sentence on every missing-secret message | `src/util/secretHint.ts` |
| The ports `fetch()` refuses before it contacts anything (WHATWG blocked list) | `src/util/fetchBlockedPorts.ts`; rebinders: `src/jobs/actions/llamacppInstall.ts` (`findFreePort`) and `test/support/listenLoopback.ts` |
| Where a past-session lookup lives (raw logs, memento keys, the open body file) | `docs/WORKSPACE_FORENSICS.md`; `test/unit/SessionForensicsDocs.test.ts` keeps that doc and the starter `FORGE.md` text agreeing |
