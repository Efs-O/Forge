import * as path from 'path';
import * as vscode from 'vscode';
import type { IBackendPool } from '../backend/BackendPool';
import type { ForgeConfig } from '../config/types';
import { loadConfig } from '../config/ConfigLoader';
import type { SidebarProvider } from '../sidebar/SidebarProvider';
import type { BackendStatusBar } from './BackendStatusBar';
import {
  activeFileBlock,
  activeSelectionBlock,
  diagnosticSnippet,
  diagnosticsForActiveFile,
  formatContextBlocks,
  nearestDiagnostic,
  openTabBlocks,
  pickFileBlocks,
  relativePath,
} from './editorContext';
import { openMarkdownScratch } from './scratchDocuments';
import { runAddModelWizard } from '../sidebar/AddModelWizard';
import { migrateConfig } from '../config/ConfigMigrator';

interface NativeCommandDeps {
  backend: IBackendPool;
  sidebar: SidebarProvider;
  statusBar: BackendStatusBar;
  getConfig: () => ForgeConfig;
  getConfigPath: () => string;
  setConfig: (config: ForgeConfig) => void;
}

export function registerNativeCommands(
  context: vscode.ExtensionContext,
  deps: NativeCommandDeps,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('forge.startBackend', async () => {
      const modelName = deps.getConfig().active_model;
      if (!modelName) {
        void vscode.window.showErrorMessage('Forge: no active model selected.');
        return;
      }
      await runBackendAction(
        deps,
        'starting',
        async () => {
          await deps.backend.acquire(modelName);
        },
        'Forge: backend started',
      );
    }),
    vscode.commands.registerCommand('forge.stopBackend', async () => {
      await runBackendAction(
        deps,
        'stopping',
        async () => deps.backend.stopAll(),
        'Forge: backend stopped',
      );
    }),
    vscode.commands.registerCommand('forge.restartBackend', async () => {
      const modelName = deps.getConfig().active_model;
      deps.statusBar.setStarting(modelName);
      try {
        await deps.backend.stopAll();
        if (modelName) await deps.backend.acquire(modelName);
        deps.statusBar.setReady(modelName);
        void vscode.window.showInformationMessage('Forge: backend restarted');
      } catch (err) {
        const message = (err as Error).message;
        deps.statusBar.setError(message);
        void vscode.window.showErrorMessage(`Forge: ${message}`);
      }
    }),
    vscode.commands.registerCommand('forge.openConfig', async () => {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(deps.getConfigPath()));
      await vscode.window.showTextDocument(doc, { preview: false });
    }),
    vscode.commands.registerCommand('forge.validateConfig', () => {
      try {
        const config = loadConfig(path.dirname(deps.getConfigPath()));
        deps.setConfig(config);
        void vscode.window.showInformationMessage('Forge: config is valid');
      } catch (err) {
        void vscode.window.showErrorMessage((err as Error).message);
      }
    }),
    vscode.commands.registerCommand('forge.pickModel', async () => {
      const config = deps.getConfig();
      const pick = await vscode.window.showQuickPick(
        config.models.map((model) => ({
          label: model.name,
          description: model.provider ?? 'llama.cpp',
          modelName: model.name,
        })),
        { placeHolder: 'Pick the Forge model to use' },
      );
      if (!pick) return;
      // F6: when request-time profiles exist, offer them as a second step. The
      // chosen base@profile becomes active_model; loading still keys on the base.
      const profileNames = Object.keys(config.profiles ?? {});
      let selectedId = pick.modelName;
      if (profileNames.length > 0) {
        const profilePick = await vscode.window.showQuickPick(
          [
            { label: '(no profile)', profile: '' },
            ...profileNames.map((p) => ({ label: p, profile: p })),
          ],
          { placeHolder: `Pick a profile for ${pick.modelName}` },
        );
        if (!profilePick) return;
        if (profilePick.profile) selectedId = `${pick.modelName}@${profilePick.profile}`;
      }
      config.active_model = selectedId;
      const selectedModel = config.models.find((m) => m.name === pick.modelName);
      if (selectedModel?.provider === 'cli') {
        deps.statusBar.setReady(selectedId);
        void vscode.window.showInformationMessage(
          `Forge: switched to ${selectedId} (external CLI agent)`,
        );
        return;
      }
      if (
        selectedModel?.provider === 'xai' ||
        selectedModel?.provider === 'openrouter' ||
        selectedModel?.provider === 'openai' ||
        selectedModel?.provider === 'openai-compatible'
      ) {
        deps.statusBar.setReady(selectedId);
        void vscode.window.showInformationMessage(
          `Forge: switched to ${selectedId} (${selectedModel.provider})`,
        );
        return;
      }
      deps.statusBar.setStarting(selectedId);
      try {
        await deps.backend.acquire(selectedId);
        deps.statusBar.setReady(selectedId);
        void vscode.window.showInformationMessage(`Forge: switched to ${selectedId}`);
      } catch (err) {
        const message = (err as Error).message;
        deps.statusBar.setError(message);
        void vscode.window.showErrorMessage(`Forge: ${message}`);
      }
    }),
    vscode.commands.registerCommand('forge.pickGgufModelFile', async () => {
      const picks = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { 'GGUF models': ['gguf'] },
        title: 'Pick a GGUF model file',
      });
      const picked = picks?.[0];
      if (!picked) return;
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(deps.getConfigPath()));
      await vscode.window.showTextDocument(doc, { preview: false });
      void vscode.window.showInformationMessage(
        `Forge: selected ${picked.fsPath}. Add it to config.yaml under models[].model_path.`,
      );
    }),
    vscode.commands.registerCommand('forge.addModel', async () => {
      try {
        const next = await runAddModelWizard(deps.getConfig(), deps.getConfigPath());
        if (!next) return;
        deps.setConfig(next);
        void vscode.window.showInformationMessage('Forge: models added successfully.');
      } catch (err) {
        void vscode.window.showErrorMessage(`Forge: ${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand('forge.compactConfig', () => {
      const configPath = deps.getConfigPath();
      try {
        const result = migrateConfig(configPath);
        if (!result.migrated) {
          const detail = result.diffs?.length ? `\n${result.diffs.join('\n')}` : '';
          void vscode.window.showErrorMessage(
            `Forge: compact config aborted — ${result.reason}${detail}`,
          );
          return;
        }
        deps.setConfig(loadConfig(path.dirname(configPath)));
        void vscode.window.showInformationMessage(
          `Forge: compacted config.yaml into ${result.groupCount} group(s) (${result.linesBefore} → ${result.linesAfter} lines). Backup: ${result.backupPath}`,
        );
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Forge: compact config failed — ${(err as Error).message}`,
        );
      }
    }),
    vscode.commands.registerCommand('forge.clearChat', () => {
      deps.sidebar.clearChat();
      void vscode.window.showInformationMessage('Forge: active chat cleared');
    }),
    vscode.commands.registerCommand('forge.unloadModel', async () => {
      const modelName = deps.getConfig().active_model;
      deps.statusBar.setStopped(modelName);
      try {
        await deps.sidebar.unloadModels();
        deps.statusBar.setStopped(modelName);
        void vscode.window.showInformationMessage('Forge: models unloaded');
      } catch (err) {
        const message = (err as Error).message;
        deps.statusBar.setError(message);
        void vscode.window.showErrorMessage(`Forge: ${message}`);
      }
    }),
    vscode.commands.registerCommand('forge.explainSelection', () =>
      prefillSelection(
        deps.sidebar,
        'Explain this code clearly. Mention behavior, inputs, outputs, side effects, and risks.',
      ),
    ),
    vscode.commands.registerCommand('forge.reviewSelection', () =>
      prefillSelection(
        deps.sidebar,
        'Review this code. Focus on bugs, edge cases, maintainability, and missing tests.',
      ),
    ),
    vscode.commands.registerCommand('forge.generateTestsForSelection', () =>
      prefillSelection(
        deps.sidebar,
        'Generate focused tests for this code. Prefer the project testing style and explain where the tests should live.',
      ),
    ),
    vscode.commands.registerCommand('forge.refactorSelection', () =>
      prefillSelection(
        deps.sidebar,
        'Propose a minimal refactor for this code. Preserve behavior and avoid broad unrelated changes.',
      ),
    ),
    vscode.commands.registerCommand('forge.runExplainSelection', async () => {
      await runSelectionPrompt(
        deps,
        'Explain this code clearly. Mention behavior, inputs, outputs, side effects, and risks.',
      );
    }),
    vscode.commands.registerCommand('forge.runReviewSelection', async () => {
      await runSelectionPrompt(
        deps,
        'Review this code. Focus on bugs, edge cases, maintainability, and missing tests.',
      );
    }),
    vscode.commands.registerCommand('forge.runGenerateTestsForSelection', async () => {
      await runSelectionPrompt(
        deps,
        'Generate focused tests for this code. Prefer the project testing style and explain where the tests should live.',
      );
    }),
    vscode.commands.registerCommand('forge.runRefactorSelection', async () => {
      await runSelectionPrompt(
        deps,
        'Propose a minimal refactor for this code. Preserve behavior and avoid broad unrelated changes.',
      );
    }),
    vscode.commands.registerCommand('forge.useCurrentFile', () =>
      prefillBlocks(
        deps.sidebar,
        'Use this file as context for the next answer.',
        activeFileBlock(),
      ),
    ),
    vscode.commands.registerCommand('forge.useSelection', () =>
      prefillBlocks(
        deps.sidebar,
        'Use this selection as context for the next answer.',
        activeSelectionBlock(),
      ),
    ),
    vscode.commands.registerCommand('forge.useOpenTabs', () =>
      prefillManyBlocks(
        deps.sidebar,
        'Use these open tabs as context for the next answer.',
        openTabBlocks(),
      ),
    ),
    vscode.commands.registerCommand('forge.pickContextFiles', async () =>
      prefillManyBlocks(
        deps.sidebar,
        'Use these files as context for the next answer.',
        await pickFileBlocks(),
      ),
    ),
    vscode.commands.registerCommand(
      'forge.explainDiagnostic',
      async (uri?: vscode.Uri, diagnostic?: vscode.Diagnostic) => {
        await prefillDiagnostic(
          deps.sidebar,
          'Explain this diagnostic and the likely root cause. Do not edit files.',
          uri,
          diagnostic,
        );
      },
    ),
    vscode.commands.registerCommand(
      'forge.fixDiagnostic',
      async (uri?: vscode.Uri, diagnostic?: vscode.Diagnostic) => {
        await prefillDiagnostic(
          deps.sidebar,
          'Propose a minimal fix for this diagnostic. Do not edit files unless I explicitly ask you to execute the fix.',
          uri,
          diagnostic,
        );
      },
    ),
    vscode.commands.registerCommand(
      'forge.runFixDiagnostic',
      async (uri?: vscode.Uri, diagnostic?: vscode.Diagnostic) => {
        await runDiagnosticPrompt(
          deps,
          'Propose a minimal fix for this diagnostic. Edit files if needed, but keep the change narrow and explain the root cause first.',
          uri,
          diagnostic,
        );
      },
    ),
    vscode.commands.registerCommand('forge.fixFileDiagnostics', async () => {
      const diagnostics = diagnosticsForActiveFile();
      const block = activeFileBlock();
      if (!block || diagnostics.length === 0) {
        void vscode.window.showInformationMessage('Forge: no diagnostics in the active file');
        return;
      }
      const summary = diagnostics
        .map((diagnostic) => {
          const code = diagnostic.code === undefined ? '' : ` code=${String(diagnostic.code)}`;
          return `- ${diagnostic.message}${code} at line ${diagnostic.range.start.line + 1}`;
        })
        .join('\n');
      deps.sidebar.prefillInput(
        `Propose a minimal plan to fix these diagnostics. Do not edit files unless I explicitly ask you to execute the fix.\n\nDiagnostics:\n${summary}\n\n${formatContextBlocks([block])}`,
      );
    }),
    vscode.commands.registerCommand('forge.draftPlanScratch', async () => {
      await draftScratch(
        deps,
        'Write a concise Markdown implementation plan for the current workspace context.',
      );
    }),
    vscode.commands.registerCommand('forge.draftReviewScratch', async () => {
      await draftScratch(
        deps,
        'Write a Markdown code review for the current selection or active file. Lead with findings, then risks and test gaps.',
      );
    }),
  );
}

async function runBackendAction(
  deps: NativeCommandDeps,
  state: 'starting' | 'stopping',
  action: () => Promise<void>,
  success: string,
): Promise<void> {
  const modelName = deps.getConfig().active_model;
  if (state === 'starting') deps.statusBar.setStarting(modelName);
  if (state === 'stopping') deps.statusBar.setStopped(modelName);
  try {
    await action();
    if (state === 'stopping') deps.statusBar.setStopped(modelName);
    else deps.statusBar.setReady(modelName);
    void vscode.window.showInformationMessage(success);
  } catch (err) {
    const message = (err as Error).message;
    deps.statusBar.setError(message);
    void vscode.window.showErrorMessage(`Forge: ${message}`);
  }
}

function prefillSelection(sidebar: SidebarProvider, instruction: string): void {
  const block = activeSelectionBlock();
  if (!block) {
    void vscode.window.showInformationMessage('Forge: select code first');
    return;
  }
  sidebar.prefillInput(`${instruction}\n\n${formatContextBlocks([block])}`);
}

function prefillBlocks(
  sidebar: SidebarProvider,
  instruction: string,
  block: ReturnType<typeof activeFileBlock>,
): void {
  if (!block) {
    void vscode.window.showInformationMessage('Forge: no active editor context found');
    return;
  }
  sidebar.prefillInput(`${instruction}\n\n${formatContextBlocks([block])}`);
}

function prefillManyBlocks(
  sidebar: SidebarProvider,
  instruction: string,
  blocks: NonNullable<ReturnType<typeof activeFileBlock>>[],
): void {
  if (blocks.length === 0) {
    void vscode.window.showInformationMessage('Forge: no files selected for context');
    return;
  }
  if (blocks.some((block) => block.truncated)) {
    void vscode.window.showWarningMessage(
      'Forge: some context was truncated before adding it to the prompt',
    );
  }
  sidebar.prefillInput(`${instruction}\n\n${formatContextBlocks(blocks)}`);
}

async function prefillDiagnostic(
  sidebar: SidebarProvider,
  instruction: string,
  uri?: vscode.Uri,
  diagnostic?: vscode.Diagnostic,
): Promise<void> {
  const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!targetUri) {
    void vscode.window.showInformationMessage('Forge: no active diagnostic target');
    return;
  }
  const targetDiagnostic = diagnostic ?? nearestDiagnostic(targetUri);
  if (!targetDiagnostic) {
    void vscode.window.showInformationMessage('Forge: no diagnostics found');
    return;
  }
  const document = await vscode.workspace.openTextDocument(targetUri);
  const source = targetDiagnostic.source ? `\nSource: ${targetDiagnostic.source}` : '';
  const code =
    targetDiagnostic.code === undefined ? '' : `\nCode: ${String(targetDiagnostic.code)}`;
  sidebar.prefillInput(
    `${instruction}\n\nFile: ${relativePath(targetUri)}\nDiagnostic: ${targetDiagnostic.message}${source}${code}\nRange: ${targetDiagnostic.range.start.line + 1}:${targetDiagnostic.range.start.character + 1}-${targetDiagnostic.range.end.line + 1}:${targetDiagnostic.range.end.character + 1}\n\nRelevant code:\n\`\`\`${document.languageId}\n${diagnosticSnippet(document, targetDiagnostic)}\n\`\`\``,
  );
}

async function draftScratch(deps: NativeCommandDeps, instruction: string): Promise<void> {
  const selection = activeSelectionBlock();
  const block = selection ?? activeFileBlock();
  if (!block) {
    void vscode.window.showInformationMessage('Forge: no editor context found for scratch output');
    return;
  }
  deps.statusBar.setGenerating(deps.getConfig().active_model);
  try {
    const content = await deps.sidebar.runPromptToMarkdown(
      `${instruction}\n\n${formatContextBlocks([block])}`,
    );
    await openMarkdownScratch(content.trim() ? content : '# Forge\n\nNo content returned.');
  } catch (err) {
    const message = (err as Error).message;
    deps.statusBar.setError(message);
    void vscode.window.showErrorMessage(`Forge: ${message}`);
  } finally {
    if (deps.backend.isAnyReady()) deps.statusBar.setReady(deps.getConfig().active_model);
  }
}

async function runSelectionPrompt(deps: NativeCommandDeps, instruction: string): Promise<void> {
  const block = activeSelectionBlock();
  if (!block) {
    void vscode.window.showInformationMessage('Forge: select code first');
    return;
  }
  deps.statusBar.setGenerating(deps.getConfig().active_model);
  try {
    await deps.sidebar.submitPrompt(`${instruction}\n\n${formatContextBlocks([block])}`);
  } catch (err) {
    const message = (err as Error).message;
    deps.statusBar.setError(message);
    void vscode.window.showErrorMessage(`Forge: ${message}`);
  }
}

async function runDiagnosticPrompt(
  deps: NativeCommandDeps,
  instruction: string,
  uri?: vscode.Uri,
  diagnostic?: vscode.Diagnostic,
): Promise<void> {
  const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!targetUri) {
    void vscode.window.showInformationMessage('Forge: no active diagnostic target');
    return;
  }
  const targetDiagnostic = diagnostic ?? nearestDiagnostic(targetUri);
  if (!targetDiagnostic) {
    void vscode.window.showInformationMessage('Forge: no diagnostics found');
    return;
  }
  const document = await vscode.workspace.openTextDocument(targetUri);
  const source = targetDiagnostic.source ? `\nSource: ${targetDiagnostic.source}` : '';
  const code =
    targetDiagnostic.code === undefined ? '' : `\nCode: ${String(targetDiagnostic.code)}`;
  deps.statusBar.setGenerating(deps.getConfig().active_model);
  try {
    await deps.sidebar.submitPrompt(
      `${instruction}\n\nFile: ${relativePath(targetUri)}\nDiagnostic: ${targetDiagnostic.message}${source}${code}\nRange: ${targetDiagnostic.range.start.line + 1}:${targetDiagnostic.range.start.character + 1}-${targetDiagnostic.range.end.line + 1}:${targetDiagnostic.range.end.character + 1}\n\nRelevant code:\n\`\`\`${document.languageId}\n${diagnosticSnippet(document, targetDiagnostic)}\n\`\`\``,
    );
  } catch (err) {
    const message = (err as Error).message;
    deps.statusBar.setError(message);
    void vscode.window.showErrorMessage(`Forge: ${message}`);
  }
}
