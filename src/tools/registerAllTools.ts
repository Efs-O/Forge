import * as vscode from 'vscode';
import type { ToolRegistry } from './ToolRegistry';
import type { SearchConfig } from '../config/types';
import {
  makeReadFileTool,
  makeWriteFileTool,
  makeReplaceSelectionTool,
  makeInsertCodeTool,
} from './builtinTools';
import { makeListDirectoryTool, makeSearchCodeTool, makeFindFilesTool } from './dirTools';
import {
  makeGetDiagnosticsTool,
  makeGetDocumentSymbolsTool,
  makeGetWorkspaceSymbolsTool,
  makeGetHoverTool,
  makeGoToDefinitionTool,
  makeFindReferencesTool,
} from './lspTools';
import {
  makeShowDiffTool,
  makeAskUserTool,
  makeShowNotificationTool,
  makeCopyToClipboardTool,
  makeReadClipboardTool,
  makeOpenUrlTool,
} from './uxTools';
import { makeWebFetchTool } from './fetchTool';
import { makeWebSearchTool } from './searchTool';
import { makeRememberTool, makeRecallTool, makeListMemoriesTool } from './memoryTools';
import {
  makeReplaceInFileTool,
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
import {
  makeGitStatusTool,
  makeGitLogTool,
  makeGitDiffTool,
  makeGitBlameTool,
  makeGitShowTool,
  makeCreateBranchTool,
  makeSwitchBranchTool,
  makeStageTool,
  makeCommitTool,
} from './gitTools';
import { makeSearchCodebaseTool } from './semanticSearchTool';
import type { IndexManager } from '../search/IndexManager';

export function registerAllTools(
  registry: ToolRegistry,
  workspaceState: vscode.Memento,
  secrets: vscode.SecretStorage,
  searchConfig: SearchConfig | undefined,
  indexManager: IndexManager,
): void {
  // v0.1 builtins
  registry.register(makeReadFileTool());
  registry.register(makeWriteFileTool());
  registry.register(makeReplaceSelectionTool());
  registry.register(makeInsertCodeTool());

  // v0.5 read-only
  registry.register(makeListDirectoryTool());
  registry.register(makeFindFilesTool());
  registry.register(makeSearchCodeTool());
  registry.register(makeSearchCodebaseTool(indexManager));
  registry.register(makeGetDiagnosticsTool());
  registry.register(makeGetDocumentSymbolsTool());
  registry.register(makeGetWorkspaceSymbolsTool());
  registry.register(makeGetHoverTool());
  registry.register(makeGoToDefinitionTool());
  registry.register(makeFindReferencesTool());
  registry.register(makeShowDiffTool());
  registry.register(makeAskUserTool());
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
  registry.register(makeReplaceInFileTool());
  registry.register(makeCreateDirectoryTool());
  registry.register(makeMoveFileTool());
  registry.register(makeDeleteFileTool());
  registry.register(makeFormatFileTool());
  registry.register(makeRenameSymbolTool());

  // v0.7 exec + git
  registry.register(makeRunTerminalTool());
  registry.register(makeExecCommandTool());
  registry.register(makeRunTestsTool());
  registry.register(makeRunBuildTool());
  registry.register(makeGitStatusTool());
  registry.register(makeGitLogTool());
  registry.register(makeGitDiffTool());
  registry.register(makeGitBlameTool());
  registry.register(makeGitShowTool());
  registry.register(makeCreateBranchTool());
  registry.register(makeSwitchBranchTool());
  registry.register(makeStageTool());
  registry.register(makeCommitTool());
}
