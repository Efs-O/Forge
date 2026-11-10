import * as path from 'path';
import { createHash } from 'crypto';
import * as vscode from 'vscode';
import type { ForgeConfig } from '../config/types';
import { BackendPool } from '../backend/BackendPool';
import type { ControlServer } from '../backend/ControlServer';
import { EmbeddingBackend } from '../backend/EmbeddingBackend';
import { CliSessionRegistry, cliSessionRegistryFromConfig } from '../agents/CliSessionRegistry';
import { LocalDelegationService } from '../delegation/LocalDelegationService';
import { IndexManager } from '../search/IndexManager';
import { createSkillsService } from '../skills/createSkillsService';
import { renderPdfPages } from '../documents/pdfRenderer';
import { connectMcpServers } from '../tools/mcpBridge';
import { ToolRegistry } from '../tools/ToolRegistry';
import { registerAllTools } from '../tools/registerAllTools';
import { mediaLifecycleFor, type MediaExternals } from './mediaLifecycle';
import { UserQuestionService } from '../sidebar/UserQuestionService';
import { UserNotificationService } from '../sidebar/UserNotificationService';
import { SidebarProvider } from '../sidebar/SidebarProvider';
import { ChatAttachmentStore } from '../sidebar/ChatAttachmentStore';
import type { TemplateEngine } from '../llm/TemplateEngine';
import { JobStore } from '../jobs/JobStore';
import { workspaceIdFor } from '../remote/RemoteWorkspaceHandoff';
import { terminalCommandTracker } from '../tools/TerminalCommandTracker';
import { getLogger } from '../util/logger';

export interface ToolActivationOptions {
  context: vscode.ExtensionContext;
  config: ForgeConfig;
  getConfig: () => ForgeConfig;
  activeConfigPath: string;
  templateEngine: TemplateEngine | undefined;
  pool: BackendPool;
  getSidebarProvider: () => SidebarProvider;
  log: ReturnType<typeof getLogger>;
  /**
   * The window's model control server, resolved per call: it is wired AFTER
   * the tool registry, and a media tool call can only happen once activation
   * has finished, so the lifecycle holds a getter rather than a value.
   */
  getControlServer?: () => ControlServer | undefined;
  /**
   * The window's managed externals (Strata) and the machine-wide managed turn
   * holds. The media lifecycle needs both: a render that wants a card a managed
   * server occupies has to see it as loaded, and it must not unload that server
   * while any window is streaming on it (BL-031).
   */
  getExternals?: () => MediaExternals;
}

export interface ToolActivationSetup {
  indexManager: IndexManager;
  workspaceRoot: string;
  workspaceId: string;
  cliSessions: CliSessionRegistry;
  toolRegistry: ToolRegistry;
  jobsStore: JobStore;
  userQuestions: UserQuestionService;
  userNotifications: UserNotificationService;
  chatAttachments: ChatAttachmentStore;
  sdServers: ReturnType<typeof registerAllTools>;
}

/** Build the tool registry and the activation-scoped services it shares. */
export function setupToolActivation(options: ToolActivationOptions): ToolActivationSetup {
  const {
    context,
    config,
    getConfig,
    activeConfigPath,
    templateEngine,
    pool,
    getSidebarProvider,
    log,
  } = options;
  // The media tools free GPUs through Forge's own lifecycle: the pool's loaded
  // entries and busy state, and the control server's unload path.
  const mediaTools = options.getControlServer
    ? {
        adaptersDir: path.join(context.extensionPath, 'resources', 'media'),
        lifecycle: mediaLifecycleFor(
          pool,
          options.getControlServer,
          getConfig,
          options.getExternals,
        ),
      }
    : undefined;

  // ── Tool registry ─────────────────────────────────────────────────────────
  const embeddingBackend = new EmbeddingBackend(config);
  context.subscriptions.push(embeddingBackend);
  const indexManager = new IndexManager(config, embeddingBackend);
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const workspaceId = workspaceRoot
    ? workspaceIdFor(workspaceRoot)
    : createHash('sha256').update(`no-workspace:${activeConfigPath}`).digest('hex');
  // Selected CLI chat models own resumable sessions; CLI delegation is one-shot.
  const cliSessions = cliSessionRegistryFromConfig(config);
  const delegationService = new LocalDelegationService({
    getConfig,
    backendPool: pool,
    workspaceRoot,
    secrets: context.secrets,
  });
  // Skills: the three roots, the per-conversation frozen catalog and the reader
  // behind `load_skill`. Built here because it needs the install folder (the
  // shipped root), the live config, the live template engine and the current
  // workspace folder, and it reads all four per call so a config reload or a
  // folder switch takes effect without re-registering anything.
  const skills = createSkillsService({
    extensionPath: context.extensionPath,
    getConfig,
    getTemplateEngine: () => templateEngine,
    getWorkspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
  });
  context.subscriptions.push(skills);
  // The catalog reaches the prompt through the engine, the one object that
  // already reaches every path that renders a system prompt (`ModelTurn`,
  // `PromptRun`). Attaching it here rather than threading a new argument through
  // `SidebarProvider`, `sidebarWiring`, `AgentLoop` and `turnServices` is a
  // deliberate shortcut: those four files sit at this repo's 500-line gate.
  templateEngine?.setSkillsCatalogProvider((conversation) => skills.catalogFor(conversation));
  const toolRegistry = new ToolRegistry();
  // One job store, shared by the scheduler and the `manage_jobs` tool.
  const jobsStore = new JobStore();
  const jobsHostFacade = () => getSidebarProvider().getHostFacade();
  // One owner for agent questions, shared by ask_user and the sidebar facade so
  // a remotely driven turn can answer from the chat that started it.
  const userQuestions = new UserQuestionService();
  // One owner for agent-authored notifications, shared by notify_user and the
  // sidebar facade so a remotely driven turn reaches the chat that started it.
  const userNotifications = new UserNotificationService(
    (message) => void vscode.window.showWarningMessage(message),
  );
  terminalCommandTracker.start();
  context.subscriptions.push(terminalCommandTracker);
  const chatAttachments = new ChatAttachmentStore(
    path.join(context.globalStorageUri.fsPath, 'chat-attachments'),
    workspaceId,
  );
  const sdServers = registerAllTools(
    toolRegistry,
    context.workspaceState,
    context.secrets,
    config.search,
    indexManager,
    userQuestions,
    userNotifications,
    delegationService,
    getConfig,
    () => pool.backendProcesses(),
    (relativePath) => chatAttachments.resolve(relativePath),
    { store: jobsStore, hostFacade: jobsHostFacade, configPath: activeConfigPath },
    (key) => getSidebarProvider().forgetMemoryKey(key),
    getSidebarProvider,
    skills,
    renderPdfPages,
    mediaTools,
  );
  // Owns the sd-server children created by tool registration.
  if (sdServers) context.subscriptions.push(sdServers);

  // External MCP stdio servers (e.g. halluscribe-mcp). Bridged as a
  // non-blocking background task: ToolRegistry.definitions() is re-read every
  // agent turn (see AgentLoop.ts), so a slow or missing server binary never
  // delays activation — its tools simply appear on a later turn once
  // connected, and connectMcpServers never throws out of this call.
  if (config.mcp_servers?.length) {
    void connectMcpServers(config.mcp_servers, toolRegistry, log)
      .then((disposable) => context.subscriptions.push(disposable))
      .catch((err) => log.error('MCP bridge failed unexpectedly', err));
  }

  return {
    indexManager,
    workspaceRoot,
    workspaceId,
    cliSessions,
    toolRegistry,
    jobsStore,
    userQuestions,
    userNotifications,
    chatAttachments,
    sdServers,
  };
}
