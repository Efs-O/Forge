# OWNERS.md — Single Point of Truth Map

These are the canonical owners for each concern. Do not duplicate logic across
modules — extend the listed file or split it. Grep before adding any new
constant, type, or function; if you find yourself about to write logic that
overlaps with an existing owner, extend the owner instead.

## Sidebar / UI

| Concern                                    | Owner                                  |
| ------------------------------------------ | -------------------------------------- |
| Extension manifest + contributions         | `package.json`                         |
| Activation / deactivation                  | `src/extension.ts`                     |
| Webview lifecycle + message bridge entry   | `src/sidebar/SidebarProvider.ts`       |
| Agent loop + streaming lifecycle           | `src/sidebar/AgentLoop.ts`             |
| Tool call execution + result formatting    | `src/sidebar/ToolDispatch.ts`          |
| Conversation CRUD pure ops                 | `src/sidebar/ConversationOps.ts`       |
| Slash command dispatch + compact           | `src/sidebar/SlashCommandHandler.ts`   |
| Webview HTML builder                       | `src/sidebar/WebviewBuilder.ts`        |
| Multi-conversation session types + persist | `src/sidebar/sessionTypes.ts`          |
| First-run setup wizard                     | `src/sidebar/FirstRunWizard.ts`        |
| Add-model setup wizard                     | `src/sidebar/AddModelWizard.ts`        |
| Missing-config setup mode                  | `src/sidebar/SetupMode.ts`             |
| Keep/Undo CodeLens decorations             | `src/sidebar/KeepUndoCodeLens.ts`      |
| Typed webview ↔ host message contract      | `src/sidebar/messageBridge.ts`         |
| In-editor green/red diff decorations       | `src/sidebar/DiffDecorations.ts`       |
| Diff computation + unified-diff parsing    | `src/sidebar/DiffUtils.ts`             |
| Session transcript logging (~/.forge)      | `src/sidebar/SessionLogger.ts`         |
| Tool-call argument summary labels          | `src/sidebar/toolSummary.ts`           |

## Backend

| Concern                                    | Owner                                  |
| ------------------------------------------ | -------------------------------------- |
| Mode-agnostic backend interface            | `src/backend/BackendController.ts`     |
| Multi-backend lifecycle + port allocation  | `src/backend/BackendPool.ts`           |
| Delegation capacity check + eviction pins  | `src/backend/DelegationGate.ts`        |
| Direct mode (llama-server spawn)           | `src/backend/DirectBackend.ts`         |
| llama-server child-process spawn/teardown  | `src/backend/llamaProcess.ts`          |
| Embedding llama-server (semantic search)   | `src/backend/EmbeddingBackend.ts`      |
| Localhost model-control HTTP API           | `src/backend/ControlServer.ts`         |
| llama-server CLI arg builder               | `src/backend/LlamaServerArgs.ts`       |
| Ollama endpoint normalization + health     | `src/backend/OllamaAdapter.ts`         |
| Backend health polling                     | `src/backend/HealthCheck.ts`           |
| GGUF file scanner                          | `src/backend/GgufScanner.ts`           |
| Model family heuristics                    | `src/backend/ModelHeuristics.ts`       |
| Runtime model capability detection         | `src/backend/ModelCapabilities.ts`     |

## Delegation

| Concern                                    | Owner                                      |
| ------------------------------------------ | ------------------------------------------ |
| Local delegation orchestration             | `src/delegation/LocalDelegationService.ts` |
| Local delegation target eligibility        | `src/delegation/eligibility.ts`            |
| Local delegation limits + prompt contract  | `src/delegation/limits.ts`                 |

## LLM / Inference

| Concern                                    | Owner                                  |
| ------------------------------------------ | -------------------------------------- |
| Unified chat dispatch (llama.cpp + Ollama) | `src/llm/ChatClient.ts`               |
| Cloud provider registry + base URLs        | `src/llm/CloudProviders.ts`            |
| xAI token resolution (SecretStorage/OAuth) | `src/llm/XaiAuth.ts`                   |
| FORGE.md workspace instructions loader     | `src/llm/ForgeInstructionsLoader.ts`   |
| Streaming OpenAI-compat client             | `src/llm/OpenAIClient.ts`              |
| Streaming Ollama native client             | `src/llm/OllamaNativeClient.ts`        |
| Request normalization (per-provider)       | `src/llm/RequestNormalizer.ts`         |
| Sampling parameter merge                   | `src/llm/SamplingMerge.ts`             |
| System-prompt injection                    | `src/llm/SystemPromptInjector.ts`      |
| Nunjucks template engine                   | `src/llm/TemplateEngine.ts`            |
| Thinking/channel tag stripper              | `src/llm/ThinkingChannelStripper.ts`   |
| HTML boilerplate stripper                  | `src/llm/HtmlDocumentBoilerplateStripper.ts` |

## Tools

| Concern                                    | Owner                                  |
| ------------------------------------------ | -------------------------------------- |
| Tool dispatch + capability/permission gate | `src/tools/ToolRegistry.ts`            |
| Config-to-tool permission resolution       | `src/tools/PermissionResolver.ts`      |
| Tool registration entry point              | `src/tools/registerAllTools.ts`        |
| Built-in tool definitions                  | `src/tools/builtinTools.ts`            |
| File read/write tools                      | `src/tools/fileEditTools.ts`           |
| Directory listing tools                    | `src/tools/dirTools.ts`                |
| Terminal + headless exec tools             | `src/tools/execTools.ts`               |
| Exec child-process helpers                 | `src/tools/execHelpers.ts`             |
| Git tools (status, diff, commit)           | `src/tools/gitTools.ts`                |
| Search (Tavily / Brave)                    | `src/tools/searchTool.ts`              |
| URL fetch tool (SSRF-guarded)              | `src/tools/fetchTool.ts`               |
| LSP tools (go-to-def, refs, diagnostics)   | `src/tools/lspTools.ts`                |
| In-memory workspace memory tool            | `src/tools/memoryTools.ts`             |
| UX tools (show_diff, open_file)            | `src/tools/uxTools.ts`                 |
| Denylist (dangerous command filter)        | `src/tools/DenyList.ts`                |
| User confirmation gate                     | `src/tools/ConfirmationGate.ts`        |
| Tool strip (remove tools from request)     | `src/tools/StripTools.ts`              |
| Structured output / fallback tool parser   | `src/tools/StructuredOutputParser.ts`  |
| Tool call JSON-fence fallback converter    | `src/tools/ToolCallFallback.ts`        |
| Semantic codebase search tool              | `src/tools/semanticSearchTool.ts`      |
| MCP client bridge (external MCP servers)   | `src/tools/mcpBridge.ts`               |
| Tool-result size capping                   | `src/tools/resultCap.ts`               |

## Semantic Search

| Concern                                    | Owner                                  |
| ------------------------------------------ | -------------------------------------- |
| Index build/update + query orchestration   | `src/search/IndexManager.ts`           |
| Embedding HTTP client (/v1/embeddings)     | `src/search/EmbeddingClient.ts`        |
| File chunking + chunk hashing              | `src/search/chunking.ts`               |
| Vector math (cosine similarity)            | `src/search/semanticMath.ts`           |
| Search index types                         | `src/search/types.ts`                  |

## Config

| Concern                                    | Owner                                  |
| ------------------------------------------ | -------------------------------------- |
| `config.yaml` schema (Zod)                 | `src/config/schema.ts`                 |
| Config load + validation                   | `src/config/ConfigLoader.ts`           |
| Two-flavor model/profile/alias resolver    | `src/config/ConfigResolver.ts`         |
| Config + model types                       | `src/config/types.ts`                  |
| Validated config backup + safe writer      | `src/config/ConfigWriter.ts`           |
| User-facing config example                 | `config/config.example.yaml`           |

## VS Code Integration

| Concern                                    | Owner                                  |
| ------------------------------------------ | -------------------------------------- |
| Status bar (backend state indicator)       | `src/vscode/BackendStatusBar.ts`       |
| Native VS Code commands                    | `src/vscode/nativeCommands.ts`         |
| SecretStorage setup commands               | `src/vscode/secretCommands.ts`         |
| Model-control palette commands             | `src/vscode/controlCommands.ts`        |
| Code action provider (quick fixes)         | `src/vscode/codeActions.ts`            |
| Editor context collector                   | `src/vscode/editorContext.ts`          |
| Scratch document (markdown preview)        | `src/vscode/scratchDocuments.ts`       |

## Misc

| Concern                                    | Owner                                  |
| ------------------------------------------ | -------------------------------------- |
| Per-turn checkpoint stack                  | `src/checkpoint/CheckpointStack.ts`    |
| Structured logging                         | `src/util/logger.ts`                   |
