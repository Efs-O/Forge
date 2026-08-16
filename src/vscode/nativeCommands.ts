import * as path from 'path';
import * as vscode from 'vscode';
import { loadConfig } from '../config/ConfigLoader';
import type { NativeCommandDeps } from './commandDeps';
import { runBackendAction } from './commandHelpers';
import { registerEditorCommands } from './editorCommands';
import { runAddModelWizard } from '../sidebar/AddModelWizard';
import { migrateConfig } from '../config/ConfigMigrator';

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
  );
  registerEditorCommands(context, deps);
}
