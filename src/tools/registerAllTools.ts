import * as vscode from 'vscode';
import type { ToolRegistry } from './ToolRegistry';
import type { SearchConfig, ForgeConfig } from '../config/types';
import type { LocalDelegationService } from '../delegation/LocalDelegationService';
import { makeLocalAgentTool, makeListDelegationTargetsTool } from './localAgentTool';
import {
  makeReadFileTool,
  makeWriteFileTool,
  makeAppendFileTool,
  makeReplaceSelectionTool,
  makeInsertCodeTool,
  makeGetEditorContextTool,
} from './builtinTools';
import { makeSearchCodeTool, makeFindFilesTool } from './dirTools';
import { makeListDirectoryTool } from './listDirectoryTool';
import { makeCodeIntelTool } from './codeIntelTool';
import { makeApplyCodeActionTool } from './codeActionTools';
import { makeEditNotebookCellTool, makeReadNotebookTool } from './notebookTools';
import { makeListWorkspaceTasksTool, makeRunWorkspaceTaskTool } from './taskTools';
import {
  makeShowDiffTool,
  makeOpenFileTool,
  makeAskUserTool,
  makeNotifyUserTool,
  makeShowNotificationTool,
  makeCopyToClipboardTool,
  makeReadClipboardTool,
  makeOpenUrlTool,
} from './uxTools';
import { PowerControl } from '../system/PowerControl';
import { makeGetPowerInfoTool, makeScheduleWakeTool, makeSleepComputerTool } from './powerTools';
import { makeWebFetchTool } from './fetchTool';
import { makeWebSearchTool } from './searchTool';
import {
  makeRememberTool,
  makeRecallTool,
  makeListMemoriesTool,
  makeForgetTool,
} from './memoryTools';
import { makeEditFileTool } from './editFileTool';
import {
  makeCreateDirectoryTool,
  makeMoveFileTool,
  makeDeleteFileTool,
  makeFormatFileTool,
  makeRenameSymbolTool,
} from './fileEditTools';
import { makeRunTerminalTool, makeExecCommandTool } from './execTools';
import { makeSafePowerShellTool } from './safePowerShellTool';
import { makeSystemStatusTool } from './systemStatusTool';
import type { BackendProcess } from '../system/SystemReport';
import { makeLoadToolGroupTool } from './toolGroupTools';
import { makeInstallLlamacppTool } from './llamacppInstallTool';
import { makeManageJobsTool } from './jobTools';
import { makeLiveSessionTool } from './liveSessionTool';
import { makeTellLiveSessionTool } from './tellLiveSessionTool';
import { makeReadToolResultTool } from './toolResultTools';
import { makeUpdatePlanTool } from './planTools';
import { makeGitReadTool } from './gitReadTool';
import {
  makeCreateBranchTool,
  makeSwitchBranchTool,
  makeStageTool,
  makeCommitTool,
  makeRestoreFileTool,
} from './gitTools';
import { makeSearchCodebaseTool } from './semanticSearchTool';
import type { IndexManager } from '../search/IndexManager';
import type { JobStore } from '../jobs/JobStore';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import { makeApplyLineEditsTool } from './structuredEditTool';
import { makeViewImageTool } from './imageTool';
import { makeSendFileTool } from './sendFileTool';
import { makeWaitTool } from './waitTool';
import { makeViewVideoTool } from './videoTool';
import { makeGenerateImageTool } from './imageGeneration/generateImageTool';
import { makeRenderHtmlToImageTool } from './renderHtmlToImageTool';
import { SdServerRegistry } from '../backend/sdServerRegistry';
import { makeImageSearchTool } from './imageSearch/imageSearchTool';
import { makeBrowserTools } from './browser/browserTools';
import { makeDesktopTools } from './desktop/desktopTools';
import {
  makeListExecutionsTool,
  makeMonitorExecutionTool,
  makeStopExecutionTool,
} from './backgroundExecutionTools';

import type { UserQuestionService } from '../sidebar/UserQuestionService';
import { makeAllowCliAgents } from '../jobs/cliAgentGate';
import type { UserNotificationService } from '../sidebar/UserNotificationService';

export function registerAllTools(
  registry: ToolRegistry,
  workspaceState: vscode.Memento,
  secrets: vscode.SecretStorage,
  searchConfig: SearchConfig | undefined,
  indexManager: IndexManager,
  questions: UserQuestionService,
  notifications: UserNotificationService,
  delegationService?: LocalDelegationService,
  getConfig?: () => ForgeConfig,
  backendProcesses?: () => readonly BackendProcess[],
  resolveChatAttachment?: (relativePath: string) => string,
  jobs?: {
    store: JobStore;
    hostFacade: () => ForgeHostFacade | undefined;
    /** The active config.yaml, for install_llamacpp's binary switch. */
    configPath?: string;
  },
  onForgetMemory?: (key: string) => void,
): SdServerRegistry | undefined {
  // config.yaml `extra_file_roots`: absolute folders outside the workspace that
  // create_directory / delete_file may also reach. A getter, so a
  // config reload applies without re-registering the tools.
  const extraRoots = (): readonly string[] => getConfig?.().extra_file_roots ?? [];
  // v0.1 builtins
  registry.register(makeReadFileTool());
  registry.register(makeViewImageTool());
  // Registered unconditionally, unlike generate_image: send_file reads a file
  // and delivers it, so it needs no config block to exist — the same reasoning
  // as view_image two lines up. Gating it on getConfig would silently drop the
  // tool wherever that getter is not supplied. `notifications` is a required
  // argument of this signature, so the delivery dependency is always present.
  registry.register(makeSendFileTool({ notifications }));
  // Registered unconditionally, beside send_file: it needs no config block to
  // exist. `browser.channel` is read to locate the binary and falls back to
  // 'chrome', and a missing binary errors at call time naming the fix. It is
  // deliberately NOT gated by permissions.browser.enabled -- that gate is for
  // interactive browsing, and this is a render engine (headless, JS disabled,
  // network blocked, per-call). See docs/plans/SEND_FILE_AND_RENDER_HTML_PLAN.md.
  registry.register(
    makeRenderHtmlToImageTool({
      ...(getConfig ? { getConfig } : {}),
      notifications,
    }),
  );
  // Registered unconditionally: getConfig is optional on this signature, and
  // gating on it would silently drop the tool wherever it is not supplied.
  registry.register(makeViewVideoTool(getConfig ? () => getConfig().video : undefined));
  registry.register(makeWriteFileTool());
  registry.register(makeAppendFileTool());
  registry.register(makeReplaceSelectionTool());
  registry.register(makeInsertCodeTool());
  registry.register(makeGetEditorContextTool());

  // v0.5 read-only
  registry.register(makeListDirectoryTool());
  registry.register(makeFindFilesTool());
  registry.register(makeSearchCodeTool());
  registry.register(makeReadToolResultTool());
  registry.register(makeUpdatePlanTool());
  registry.register(makeSearchCodebaseTool(indexManager));
  registry.register(makeCodeIntelTool());
  registry.register(makeReadNotebookTool());
  registry.register(makeListWorkspaceTasksTool());
  registry.register(makeShowDiffTool());
  registry.register(makeOpenFileTool());
  registry.register(makeAskUserTool(questions));
  registry.register(makeNotifyUserTool(notifications));

  // Power control. One PowerControl instance for all three: it is stateless,
  // and a second one would be a second owner of the same spawn sites.
  const power = new PowerControl();
  registry.register(makeGetPowerInfoTool(power));
  registry.register(makeScheduleWakeTool(power));
  registry.register(makeSleepComputerTool(power));
  registry.register(makeWaitTool());
  registry.register(makeShowNotificationTool());
  registry.register(makeCopyToClipboardTool());
  registry.register(makeReadClipboardTool());
  registry.register(makeOpenUrlTool());
  registry.register(makeWebFetchTool());
  registry.register(makeRememberTool(workspaceState));
  registry.register(makeRecallTool(workspaceState));
  registry.register(makeListMemoriesTool(workspaceState));
  registry.register(makeForgetTool(workspaceState, onForgetMemory));
  if (searchConfig) {
    registry.register(makeWebSearchTool(secrets, searchConfig));
  }

  // v0.6 write tools
  registry.register(makeEditFileTool());
  registry.register(makeApplyLineEditsTool());
  registry.register(makeCreateDirectoryTool(extraRoots));
  registry.register(makeMoveFileTool());
  registry.register(makeDeleteFileTool(extraRoots));
  registry.register(makeFormatFileTool());
  registry.register(makeRenameSymbolTool());
  registry.register(makeApplyCodeActionTool());
  registry.register(makeEditNotebookCellTool());

  // v0.7 exec + git
  registry.register(makeRunTerminalTool());
  registry.register(
    makeExecCommandTool(
      () => getConfig?.().permissions?.exec?.shell_scripts === true,
      () => registry.names(),
    ),
  );
  registry.register(makeMonitorExecutionTool());
  registry.register(makeStopExecutionTool());
  registry.register(makeListExecutionsTool());
  registry.register(makeSafePowerShellTool());
  registry.register(makeSystemStatusTool(backendProcesses ? { backendProcesses } : {}));
  registry.register(makeRunWorkspaceTaskTool());
  registry.register(makeGitReadTool());
  registry.register(makeCreateBranchTool());
  registry.register(makeSwitchBranchTool());
  registry.register(makeStageTool());
  registry.register(makeCommitTool());
  registry.register(makeRestoreFileTool());

  // delegation — only registered when a LocalDelegationService is wired in
  if (delegationService && getConfig) {
    registry.register(makeLocalAgentTool(delegationService, getConfig));
    registry.register(makeListDelegationTargetsTool(getConfig));
  }

  // Self-suppressing until config.yaml has an image_generation block, so a
  // config without one keeps the tool list -- and the KV prefix -- unchanged.
  //
  // The `sd-server` children are built here, beside the tool that dispatches to
  // them, and returned: `registerAllTools` is called once per activation and the
  // tool reads the live config through `getConfig`, so a config reload never
  // re-registers the tool. The registry is what makes ledger row 1 true -- the
  // caller disposes it on deactivate and calls `applyForgeConfig` on reload, so
  // removing or editing an `sdcpp` backend stops its process instead of leaking
  // a server that holds VRAM forever.
  let sdServers: SdServerRegistry | undefined;
  if (getConfig) {
    sdServers = new SdServerRegistry(getConfig());
    registry.register(
      makeGenerateImageTool({
        getConfig,
        secrets,
        notifications,
        sdServers: () => sdServers?.handles() ?? new Map(),
      }),
    );
    // Same self-suppression, keyed on an image_search block.
    registry.register(
      makeImageSearchTool({
        getConfig,
        secrets,
        notifications,
        ...(resolveChatAttachment ? { resolveAttachment: resolveChatAttachment } : {}),
      }),
    );
  }

  // Persistent agent jobs (B2). Self-suppressing until a `jobs:` block is
  // present, so a config without one keeps the tool list unchanged. The tool
  // needs `getConfig` for its advertise predicate, so it is registered only
  // when both the jobs wiring and a config getter are supplied.
  if (jobs && getConfig) {
    registry.register(
      makeManageJobsTool({
        store: jobs.store,
        getConfig,
        ...(jobs.hostFacade ? { hostFacade: jobs.hostFacade } : {}),
        ...(jobs.configPath ? { allowCliAgents: makeAllowCliAgents(jobs.configPath) } : {}),
      }),
    );
  }

  // On-demand llama.cpp install: the jobs action's pipeline without a job.
  if (getConfig) {
    registry.register(makeInstallLlamacppTool({ getConfig, configPath: jobs?.configPath }));
  }

  // Agent messaging. Self-suppressing until `agent_bus.enabled`, so a config
  // without it keeps the tool list unchanged.
  if (getConfig) {
    registry.register(
      makeLiveSessionTool({
        getConfig,
        workspaceRoots: () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
      }),
    );
    // The one-way push (P0): a distinct typed primitive, not ask with wait:false.
    registry.register(makeTellLiveSessionTool({ getConfig }));
  }

  // Browser tools (plan §4.2): registered when a config getter exists; the
  // `browser` permission (deny-by-default) filters advertisement and dispatch, so
  // a config without `permissions.browser.enabled` advertises none of them and
  // the native prefix stays byte-identical for existing users.
  if (getConfig) {
    for (const tool of makeBrowserTools(getConfig)) registry.register(tool);
    // Desktop tools (plan §4.2): same pattern; `desktop` permission +
    // `advertise: isWin` (B7) filter advertisement and dispatch.
    for (const tool of makeDesktopTools(getConfig)) registry.register(tool);
  }

  // Registered last, and self-suppressing until a lazy group is actually
  // bridged in: definitions() follows insertion order, so appending here
  // leaves the native prefix above byte-identical for the KV cache.
  registry.register(makeLoadToolGroupTool());
  return sdServers;
}
