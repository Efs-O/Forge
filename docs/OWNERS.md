# OWNERS.md — Single Point of Truth Map

These are the canonical owners for each concern. Do not duplicate logic across
modules — extend the listed file or split it. Grep before adding any new
constant, type, or function; if you find yourself about to write logic that
overlaps with an existing owner, extend the owner instead.

## Sidebar / UI

| Concern                                    | Owner                                |
| ------------------------------------------ | ------------------------------------ |
| Extension manifest + contributions         | `package.json`                       |
| Activation / deactivation                  | `src/extension.ts`                   |
| Webview lifecycle + message bridge entry   | `src/sidebar/SidebarProvider.ts`     |
| Webview message routing                    | `src/sidebar/webviewMessageRouter.ts`|
| Sidebar collaborator construction          | `src/sidebar/sidebarWiring.ts`       |
| Ctx bar, HalluMeter bridge, thresholds     | `src/sidebar/ContextBudgetPublisher.ts`|
| Tab create/switch/close/restore + VRAM     | `src/sidebar/ConversationTabs.ts`    |
| Send guards, model resolution, turn logs   | `src/sidebar/SendPipeline.ts`        |
| /reindex progress interaction              | `src/sidebar/reindexCommand.ts`      |
| Primary turn + streaming lifecycle         | `src/sidebar/AgentLoop.ts`           |
| Per-conversation streaming/cancel state    | `src/sidebar/TurnLifecycle.ts`       |
| Model-endpoint turn: preflight + request   | `src/sidebar/ModelTurn.ts`           |
| Cloud target / local backend startup       | `src/sidebar/ProviderTurn.ts`        |
| Turn served by a local CLI agent           | `src/sidebar/CliTurn.ts`             |
| Worker dispatch + coordinator review       | `src/sidebar/WorkerTurn.ts`          |
| One-shot prompt (compaction, /review)      | `src/sidebar/PromptRun.ts`           |
| Thinking kwargs, strip, template context   | `src/sidebar/turnModelBehavior.ts`   |
| Collaborator set handed to turn modules    | `src/sidebar/turnServices.ts`        |
| Confirmation FIFO + clanker bypass policy  | `src/sidebar/ToolApprovalService.ts` |
| Tool call execution + result formatting    | `src/sidebar/ToolDispatch.ts`        |
| Conversation CRUD pure ops                 | `src/sidebar/ConversationOps.ts`     |
| Slash command dispatch                     | `src/sidebar/SlashCommandHandler.ts` |
| Compaction: cut point, summary, resume     | `src/sidebar/CompactionService.ts`   |
| Applying the compaction window to a request| `src/sidebar/compactionWindow.ts`    |
| Webview HTML builder                       | `src/sidebar/WebviewBuilder.ts`      |
| Multi-conversation session types + persist | `src/sidebar/sessionTypes.ts`        |
| Session load/save/migrate (workspaceState) | `src/sidebar/sessionPersistence.ts`  |
| First-run setup wizard                     | `src/sidebar/FirstRunWizard.ts`      |
| Add-model setup wizard                     | `src/sidebar/AddModelWizard.ts`      |
| Missing-config setup mode                  | `src/sidebar/SetupMode.ts`           |
| Keep/Undo CodeLens decorations             | `src/sidebar/KeepUndoCodeLens.ts`    |
| Typed webview ↔ host message contract      | `src/sidebar/messageBridge.ts`       |
| In-editor green/red diff decorations       | `src/sidebar/DiffDecorations.ts`     |
| Diff computation + unified-diff parsing    | `src/sidebar/DiffUtils.ts`           |
| Session transcript logging (~/.forge)      | `src/sidebar/SessionLogger.ts`       |
| Tool-call argument summary labels          | `src/sidebar/toolSummary.ts`         |
| Runtime capability memo + warn-once ledger | `src/sidebar/CapabilityCache.ts`     |

## Chat webview transcript

| Concern                                          | Owner                                          |
| ------------------------------------------------ | ---------------------------------------------- |
| Streamed assistant turn finalization             | `src/agent/StreamedAssistantTurn.ts`           |
| Webview state reducer (per-conversation keying)  | `webview-ui/src/reducer.ts`                    |
| Transcript row folding (diff / thinking runs)    | `webview-ui/src/components/MessageList.tsx`    |
| Single-file diff rendering + stats               | `webview-ui/src/components/DiffBlock.tsx`      |
| Per-turn multi-file diff summary card            | `webview-ui/src/components/DiffGroup.tsx`      |
| Compact per-round reasoning rows                 | `webview-ui/src/components/ThinkingGroup.tsx`  |
| Tool call rows + expandable results              | `webview-ui/src/components/ToolRow.tsx`        |
| Message list ops + session-sync reconciliation   | `webview-ui/src/messageOps.ts`                 |
| Webview state shape, selectors, action union     | `webview-ui/src/appState.ts`                   |
| Render-time path/URL linkification               | `webview-ui/src/linkify.ts`                    |
| Tool result labelling for the transcript         | `src/sidebar/toolResultView.ts`                |
| Checkpoint review (virtual pre-turn documents)   | `src/sidebar/CheckpointReview.ts`              |
| Undo-history depth cap + review snapshots        | `src/checkpoint/checkpointHistory.ts`          |
| Diff card styles                                 | `webview-ui/styles/diff.css`                   |
| Tool + thinking row styles                       | `webview-ui/styles/tool-rows.css`              |

## Model Manager (F7/§2.3)

| Concern                                        | Owner                                            |
| ----------------------------------------------- | ------------------------------------------------ |
| Typed webview ↔ host message contract           | `src/sidebar/modelManager/messages.ts`            |
| Panel lifecycle + message dispatch (singleton)  | `src/sidebar/modelManager/ModelManagerPanel.ts`   |
| Panel HTML/CSP/nonce builder                    | `src/sidebar/modelManager/panelHtml.ts`           |
| Full-state assembly (stateless view contract)   | `src/sidebar/modelManager/modelSnapshot.ts`       |
| Group/defaults merge + inherited-key detection  | `src/sidebar/modelManager/resolvedView.ts`        |
| Field edit / remove / purge write path          | `src/sidebar/modelManager/editOps.ts`             |
| Scan → candidate list → auto-generated entries  | `src/sidebar/modelManager/scanOps.ts`             |
| Groups ("boards") editor write path             | `src/sidebar/modelManager/groupsOps.ts`           |
| `last_used` tracking (.forge/state.json)        | `src/sidebar/modelManager/usageTracker.ts`        |
| Webview entry point + master-detail shell       | `webview-ui/src/modelManager/App.tsx`             |
| Webview state reducer                           | `webview-ui/src/modelManager/reducer.ts`          |
| Webview host bridge wrapper                     | `webview-ui/src/modelManager/vscode.ts`           |

## CLI agent lifecycle

| Concern                                      | Owner                                |
| -------------------------------------------- | ------------------------------------ |
| Shared CLI spawn and process-tree cleanup    | `src/agents/cliProcess.ts`            |
| One-shot worker/delegation CLI execution     | `src/agents/CliAgentDriver.ts`        |
| Warm direct-chat CLI process lifecycle       | `src/agents/CliAgentSession.ts`       |
| Codex app-server JSON-RPC session            | `src/agents/CodexAppServerSession.ts` |
| JSON-RPC-over-stdio framing + correlation    | `src/agents/jsonRpcStdio.ts`          |
| Codex turn text assembly + de-duplication    | `src/agents/codexTurnText.ts`         |
| Codex app-server sandbox launch flags        | `src/agents/codexAppServerArgs.ts`    |
| Conversation/model ownership, cap, and idle eviction | `src/agents/CliSessionRegistry.ts` |
| Direct-chat CLI run (cold + warm) and task text | `src/agents/CliChatRunner.ts`       |
| Codex approval decisions (bounded autonomy)  | `src/agents/CodexApprovalPolicy.ts`   |
| Pre-run disk checkpoint for full-access CLIs | `src/agents/WorkspaceCheckpoint.ts`   |
| Windows `.cmd` shim quoting (DEP0190 escape) | `src/agents/windowsCmdShim.ts`        |

## Backend

| Concern                                   | Owner                              |
| ----------------------------------------- | ---------------------------------- |
| Mode-agnostic backend interface           | `src/backend/BackendController.ts` |
| Multi-backend lifecycle + port allocation | `src/backend/BackendPool.ts`       |
| llama.cpp slot table + LRU eviction       | `src/backend/poolSlots.ts`         |
| Ollama + borrowed-runtime acquisition     | `src/backend/poolAcquisition.ts`   |
| Delegation capacity check + eviction pins | `src/backend/DelegationGate.ts`    |
| Direct mode (llama-server spawn)          | `src/backend/DirectBackend.ts`     |
| Adopted llama-server health polling       | `src/backend/adoptedServerMonitor.ts` |
| llama-server child-process spawn/teardown | `src/backend/llamaProcess.ts`      |
| Embedding llama-server (semantic search)  | `src/backend/EmbeddingBackend.ts`  |
| Localhost model-control HTTP API          | `src/backend/ControlServer.ts`     |
| Control-server load/capacity/unload       | `src/backend/ControlModelLifecycle.ts` |
| Control-server HTTP/serialization helpers | `src/backend/controlHttp.ts`       |
| `/models` catalog contract + availability | `src/backend/ControlModelCatalog.ts` |
| Control-server discovery records (LOCALAPPDATA) | `src/backend/ControlServerRegistry.ts` |
| Machine-wide llama.cpp runtime discovery + leases | `src/backend/SharedRuntimeRegistry.ts` |
| llama-server CLI arg builder              | `src/backend/LlamaServerArgs.ts`   |
| Ollama endpoint normalization + health    | `src/backend/OllamaAdapter.ts`     |
| Backend health polling                    | `src/backend/HealthCheck.ts`       |
| GGUF file scanner                         | `src/backend/GgufScanner.ts`       |
| Model family heuristics                   | `src/backend/ModelHeuristics.ts`   |
| Runtime model capability detection        | `src/backend/ModelCapabilities.ts` |

## Delegation

| Concern                                   | Owner                                      |
| ----------------------------------------- | ------------------------------------------ |
| Local delegation orchestration            | `src/delegation/LocalDelegationService.ts` |
| Local delegation target eligibility       | `src/delegation/eligibility.ts`            |
| Local delegation limits + prompt contract | `src/delegation/limits.ts`                 |
| `ask_local_agent` for `provider: cli` targets | `src/delegation/CliDelegationRunner.ts` |

## CLI Agents (`provider: cli` — F7/§2.4)

| Concern                                              | Owner                                 |
| ----------------------------------------------------- | -------------------------------------- |
| Shared types (adapter contract, event/result shapes)  | `src/agents/types.ts`                  |
| Spawn/stream/cancel/timeout lifecycle                 | `src/agents/CliAgentDriver.ts`         |
| PATH/absolute-path executable resolution              | `src/agents/resolveCliExecutable.ts`   |
| Structured driver error type                          | `src/agents/CliAgentError.ts`          |
| Per-CLI adapter registry                              | `src/agents/adapters/index.ts`         |
| Claude Code stream-json adapter                       | `src/agents/adapters/claudeAdapter.ts` |
| Codex JSONL adapter                                   | `src/agents/adapters/codexAdapter.ts`  |
| `dispatch_workers` cli-provider run (checkpoint + task prompt) | `src/agents/CliWorkerRunner.ts` |

## LLM / Inference

| Concern                                    | Owner                                        |
| ------------------------------------------ | -------------------------------------------- |
| Unified chat dispatch (llama.cpp + Ollama) | `src/llm/ChatClient.ts`                      |
| Cloud provider registry + base URLs        | `src/llm/CloudProviders.ts`                  |
| Cloud request URL + secret resolution      | `src/llm/CloudRequestResolver.ts`            |
| Local/cloud route classification           | `src/llm/ModelRouteClassifier.ts`            |
| Shared native/fallback tool-calling loop   | `src/agent/ToolCallingLoop.ts`               |
| Truncated tool call: detection + recovery  | `src/agent/truncationRecovery.ts`            |
| Repeated identical tool call detection     | `src/agent/ToolLoopGuard.ts`                 |
| Chat message / tool call wire types        | `src/llm/types.ts`                           |
| Buffered in-host chat for POST /chat       | `src/llm/ControlChatProxy.ts`                |
| xAI token resolution (SecretStorage/OAuth) | `src/llm/XaiAuth.ts`                         |
| FORGE.md workspace instructions loader     | `src/llm/ForgeInstructionsLoader.ts`         |
| Streaming OpenAI-compat client             | `src/llm/OpenAIClient.ts`                    |
| Cut-off tool call: type + classification   | `src/llm/ToolCallTruncatedError.ts`          |
| Context measured + output budget estimate  | `src/util/contextBudget.ts`                  |
| Token-count display formatting             | `src/util/formatTokens.ts`                   |
| Streaming Ollama native client             | `src/llm/OllamaNativeClient.ts`              |
| Request normalization (per-provider)       | `src/llm/RequestNormalizer.ts`               |
| Sampling parameter merge                   | `src/llm/SamplingMerge.ts`                   |
| System-prompt injection                    | `src/llm/SystemPromptInjector.ts`            |
| Nunjucks template engine                   | `src/llm/TemplateEngine.ts`                  |
| Thinking/channel tag stripper              | `src/llm/ThinkingChannelStripper.ts`         |
| HTML boilerplate stripper                  | `src/llm/HtmlDocumentBoilerplateStripper.ts` |

## Tools

| Concern                                    | Owner                                 |
| ------------------------------------------ | ------------------------------------- |
| Tool dispatch + capability/permission gate | `src/tools/ToolRegistry.ts`           |
| Config-to-tool permission resolution       | `src/tools/PermissionResolver.ts`     |
| Tool registration entry point              | `src/tools/registerAllTools.ts`       |
| Built-in tool definitions                  | `src/tools/builtinTools.ts`           |
| Single-write size ceiling + chunk advice   | `src/tools/writeChunking.ts`          |
| File read/write tools                      | `src/tools/fileEditTools.ts`          |
| `edit_file` tool                           | `src/tools/editFileTool.ts`           |
| `old_str` matching + line-ending handling  | `src/tools/editMatch.ts`              |
| Structured line-edit validation + tool     | `src/tools/structuredEditTool.ts`     |
| Directory listing tools                    | `src/tools/dirTools.ts`               |
| Terminal + headless exec tools             | `src/tools/execTools.ts`              |
| Exec child-process helpers                 | `src/tools/execHelpers.ts`            |
| exec_command program resolution            | `src/tools/execProgramResolver.ts`    |
| Git tools (status, diff, commit)           | `src/tools/gitTools.ts`               |
| Read-only git tools (status, log, diff)    | `src/tools/gitReadTools.ts`           |
| VS Code Git API access + path/status maps  | `src/tools/gitRepo.ts`                |
| Search (Tavily / Brave)                    | `src/tools/searchTool.ts`             |
| URL fetch tool (SSRF-guarded)              | `src/tools/fetchTool.ts`              |
| LSP tools (go-to-def, refs, diagnostics)   | `src/tools/lspTools.ts`               |
| In-memory workspace memory tool            | `src/tools/memoryTools.ts`            |
| UX tools (show_diff, open_file)            | `src/tools/uxTools.ts`                |
| Denylist (dangerous command filter)        | `src/tools/DenyList.ts`               |
| User confirmation request + response flow  | `src/sidebar/ToolApprovalService.ts`  |
| Tool strip (remove tools from request)     | `src/tools/StripTools.ts`             |
| Structured output / fallback tool parser   | `src/tools/StructuredOutputParser.ts` |
| Tool call JSON-fence fallback converter    | `src/tools/ToolCallFallback.ts`       |
| Fallback tool-format prompt instructions   | `src/tools/FallbackToolPrompt.ts`     |
| Allowlisted PowerShell query tool          | `src/tools/safePowerShellTool.ts`     |
| Semantic codebase search tool              | `src/tools/semanticSearchTool.ts`     |
| MCP client bridge (external MCP servers)   | `src/tools/mcpBridge.ts`              |
| Tool-result size capping                   | `src/tools/resultCap.ts`              |
| Bundled ripgrep executable resolution      | `src/tools/RipgrepResolver.ts`        |
| Local agent delegation tool                | `src/tools/localAgentTool.ts`         |
| Worker orchestration model tool            | `src/tools/dispatchWorkersTool.ts`    |
| Per-turn tool allowlist + call-budget      | `src/tools/ToolBudget.ts`             |

## Coding Workers

| Concern                                    | Owner                                       |
| ------------------------------------------ | ------------------------------------------- |
| Worker request/result contracts + activity | `src/workers/types.ts`                      |
| Worker limits and budgets                  | `src/workers/limits.ts`                     |
| Exact-path/read-budget policy              | `src/workers/WorkerAccessPolicy.ts`         |
| Worker discovery argument validation       | `src/workers/WorkerToolValidators.ts`       |
| Coordinator delegation/review prompts      | `src/workers/WorkerPrompts.ts`              |
| Worker tool-calling configuration          | `src/workers/WorkerLoop.ts`                 |
| Run admission, execution, aggregation      | `src/workers/WorkerOrchestrationService.ts` |

## Semantic Search

| Concern                                  | Owner                           |
| ---------------------------------------- | ------------------------------- |
| Index build/update + query orchestration | `src/search/IndexManager.ts`    |
| Embedding HTTP client (/v1/embeddings)   | `src/search/EmbeddingClient.ts` |
| Embedding task-prefix formatting         | `src/search/embeddingPrompts.ts` |
| File chunking + chunk hashing            | `src/search/chunking.ts`        |
| Vector math (cosine similarity)          | `src/search/semanticMath.ts`    |
| Search index types                       | `src/search/types.ts`           |

## Config

| Concern                                 | Owner                          |
| --------------------------------------- | ------------------------------ |
| `config.yaml` schema (Zod)              | `src/config/schema.ts`         |
| Shared Zod primitives (groups/spawn/sampling) | `src/config/schemaShared.ts` |
| Config load + validation                | `src/config/ConfigLoader.ts`   |
| Two-flavor model/profile/alias resolver | `src/config/ConfigResolver.ts` |
| Config + model types                    | `src/config/types.ts`          |
| Comment-preserving config writer (entry point) | `src/config/ConfigWriter.ts` |
| YAML Document mutation helpers (set/add/remove) | `src/config/ConfigWriterHelpers.ts` |
| Groups migration orchestration + resolved-diff verifier | `src/config/ConfigMigrator.ts` |
| Groups migration clustering/lifting heuristic | `src/config/ConfigGroupHeuristic.ts` |
| Schema-valid starter config generation  | `src/config/StarterConfig.ts`  |
| User-facing config example              | `config/config.example.yaml`   |

## VS Code Integration

| Concern                              | Owner                            |
| ------------------------------------ | -------------------------------- |
| Status bar (backend state indicator) | `src/vscode/BackendStatusBar.ts` |
| Native VS Code commands              | `src/vscode/nativeCommands.ts`   |
| Editor-context commands              | `src/vscode/editorCommands.ts`   |
| Command behaviour (prefill, run)     | `src/vscode/commandHelpers.ts`   |
| Shared command dependency type       | `src/vscode/commandDeps.ts`      |
| Checkpoint settings -> stack         | `src/vscode/checkpointSetup.ts`  |
| config.yaml hot-reload               | `src/vscode/configReload.ts`     |
| Worker dispatch command              | `src/vscode/workerCommands.ts`   |
| SecretStorage setup commands         | `src/vscode/secretCommands.ts`   |
| Model-control palette commands       | `src/vscode/controlCommands.ts`  |
| Code action provider (quick fixes)   | `src/vscode/codeActions.ts`      |
| Editor context collector             | `src/vscode/editorContext.ts`    |
| Scratch document (markdown preview)  | `src/vscode/scratchDocuments.ts` |
| Sidebar/panel + Keep/Undo commands   | `src/vscode/sidebarCommands.ts`  |

## Checkpoints

| Concern                                          | Owner                                       |
| ------------------------------------------------ | ------------------------------------------- |
| Per-turn checkpoint stack (public entry point)   | `src/checkpoint/CheckpointStack.ts`         |
| Undo-history depth cap + review snapshots        | `src/checkpoint/checkpointHistory.ts`       |
| Disk-backed capture + commit                     | `src/checkpoint/DiskCheckpointStore.ts`     |
| Disk-backed restore + discard                    | `src/checkpoint/DiskCheckpointRestore.ts`   |
| In-memory snapshot capture/restore               | `src/checkpoint/MemoryCheckpointState.ts`   |
| Workspace/paths inventory walk                   | `src/checkpoint/CheckpointInventory.ts`     |
| On-disk manifest schema + versioning             | `src/checkpoint/CheckpointManifest.ts`      |
| Change detection + inventory comparison          | `src/checkpoint/CheckpointDiff.ts`          |
| Size/count limits + free-space assertions        | `src/checkpoint/CheckpointPolicy.ts`        |
| Atomic writes, hashing, abort checks             | `src/checkpoint/CheckpointFileIO.ts`        |
| Leftover-checkpoint reporting on startup         | `src/checkpoint/CheckpointRecovery.ts`      |

## Misc

| Concern                              | Owner                               |
| ------------------------------------ | ----------------------------------- |
| Path containment test (vscode-free)  | `src/util/pathContainment.ts`       |
| Workspace path resolution + realpath | `src/util/WorkspacePaths.ts`        |
| Structured logging                   | `src/util/logger.ts`                |
