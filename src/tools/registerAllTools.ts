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
import {
  makeGetDiagnosticsTool,
  makeGetDocumentSymbolsTool,
  makeGetWorkspaceSymbolsTool,
  makeGetHoverTool,
  makeGoToDefinitionTool,
  makeFindReferencesTool,
  makeFindImplementationsTool,
} from './lspTools';
import { makeApplyCodeActionTool, makeGetCodeActionsTool } from './codeActionTools';
import { makeEditNotebookCellTool, makeReadNotebookTool } from './notebookTools';
import { makeListWorkspaceTasksTool, makeRunWorkspaceTaskTool } from './taskTools';
import {
  makeShowDiffTool,
  makeAskUserTool,
  makeNotifyUserTool,
  makeShowNotificationTool,
  makeCopyToClipboardTool,
  makeReadClipboardTool,
  makeOpenUrlTool,
} from './uxTools';
import { makeWebFetchTool } from './fetchTool';
import { makeWebSearchTool } from './searchTool';
import { makeRememberTool, makeRecallTool, makeListMemoriesTool } from './memoryTools';
import { makeEditFileTool } from './editFileTool';
import {
  makeCreateDirectoryTool,
  makeMoveFileTool,
  makeDeleteFileTool,
  makeFormatFileTool,
  makeRenameSymbolTool,
} from './fileEditTools';
import {
  makeRunTerminalTool,
  makeExecCommandTool,
  makeRunTestsTool,
  makeRunBuildTool,
} from './execTools';
import { makeSafePowerShellTool } from './safePowerShellTool';
import { makeSystemStatusTool } from './systemStatusTool';
import type { BackendProcess } from '../system/SystemReport';
import { makeLoadToolGroupTool } from './toolGroupTools';
import { makeReadToolResultTool } from './toolResultTools';
import { makeUpdatePlanTool } from './planTools';
import {
  makeGitStatusTool,
  makeGitLogTool,
  makeGitDiffTool,
  makeGitBlameTool,
  makeGitShowTool,
} from './gitReadTools';
import {
  makeCreateBranchTool,
  makeSwitchBranchTool,
  makeStageTool,
  makeCommitTool,
} from './gitTools';
import { makeSearchCodebaseTool } from './semanticSearchTool';
import type { IndexManager } from '../search/IndexManager';
import { makeApplyLineEditsTool } from './structuredEditTool';
import { makeViewImageTool } from './imageTool';
import { makeWaitTool } from './waitTool';
import { makeViewVideoTool } from './videoTool';
import {
  makeListExecutionsTool,
  makeMonitorExecutionTool,
  makeStopExecutionTool,
} from './backgroundExecutionTools';

import type { UserQuestionService } from '../sidebar/UserQuestionService';
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
): void {
  // v0.1 builtins
  registry.register(makeReadFileTool());
  registry.register(makeViewImageTool());
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
  registry.register(makeGetDiagnosticsTool());
  registry.register(makeGetDocumentSymbolsTool());
  registry.register(makeGetWorkspaceSymbolsTool());
  registry.register(makeGetHoverTool());
  registry.register(makeGoToDefinitionTool());
  registry.register(makeFindReferencesTool());
  registry.register(makeFindImplementationsTool());
  registry.register(makeGetCodeActionsTool());
  registry.register(makeReadNotebookTool());
  registry.register(makeListWorkspaceTasksTool());
  registry.register(makeShowDiffTool());
  registry.register(makeAskUserTool(questions));
  registry.register(makeNotifyUserTool(notifications));
  registry.register(makeWaitTool());
  registry.register(makeShowNotificationTool());
  registry.register(makeCopyToClipboardTool());
  registry.register(makeReadClipboardTool());
  registry.register(makeOpenUrlTool());
  registry.register(makeWebFetchTool());
  registry.register(makeRememberTool(workspaceState));
  registry.register(makeRecallTool(workspaceState));
  registry.register(makeListMemoriesTool(workspaceState));
  if (searchConfig) {
    registry.register(makeWebSearchTool(secrets, searchConfig));
  }

  // v0.6 write tools
  registry.register(makeEditFileTool());
  registry.register(makeApplyLineEditsTool());
  registry.register(makeCreateDirectoryTool());
  registry.register(makeMoveFileTool());
  registry.register(makeDeleteFileTool());
  registry.register(makeFormatFileTool());
  registry.register(makeRenameSymbolTool());
  registry.register(makeApplyCodeActionTool());
  registry.register(makeEditNotebookCellTool());

  // v0.7 exec + git
  registry.register(makeRunTerminalTool());
  registry.register(makeExecCommandTool());
  registry.register(makeMonitorExecutionTool());
  registry.register(makeStopExecutionTool());
  registry.register(makeListExecutionsTool());
  registry.register(makeSafePowerShellTool());
  registry.register(makeSystemStatusTool(backendProcesses ? { backendProcesses } : {}));
  registry.register(makeRunTestsTool());
  registry.register(makeRunBuildTool());
  registry.register(makeRunWorkspaceTaskTool());
  registry.register(makeGitStatusTool());
  registry.register(makeGitLogTool());
  registry.register(makeGitDiffTool());
  registry.register(makeGitBlameTool());
  registry.register(makeGitShowTool());
  registry.register(makeCreateBranchTool());
  registry.register(makeSwitchBranchTool());
  registry.register(makeStageTool());
  registry.register(makeCommitTool());

  // delegation — only registered when a LocalDelegationService is wired in
  if (delegationService && getConfig) {
    registry.register(makeLocalAgentTool(delegationService, getConfig));
    registry.register(makeListDelegationTargetsTool(getConfig));
  }

  // Registered last, and self-suppressing until a lazy group is actually
  // bridged in: definitions() follows insertion order, so appending here
  // leaves the native prefix above byte-identical for the KV cache.
  registry.register(makeLoadToolGroupTool());
}
