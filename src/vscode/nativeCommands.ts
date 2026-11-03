import * as path from 'path';
import * as vscode from 'vscode';
import { loadConfig } from '../config/ConfigLoader';
import type { NativeCommandDeps } from './commandDeps';
import { runBackendAction } from './commandHelpers';
import { restartBackend, startBackend } from '../backend/restartBackend';
import { registerEditorCommands } from './editorCommands';
import { registerAgentBusCommands } from './agentBusCommands';
import { runAddModelWizard } from '../sidebar/AddModelWizard';
import { migrateConfig } from '../config/ConfigMigrator';
import { runPolicyMigration } from '../config/policyMigration';
import { availableProfilesFor, mergeGroupsIntoModel } from '../config/ConfigResolver';
import { defaultPolicyPath } from '../config/PolicyLoader';
import {
  lockPolicyFile,
  policyLockSentence,
  readPolicyLockState,
  unlockPolicyFile,
  type PolicyLockReport,
} from '../config/policyLock';
import { getLogger } from '../util/logger';

/**
 * Report a lock change in the one sentence that says what the file is now, and
 * offer the way back.
 *
 * Two defects the 0.17.117 live test found, both fixed here because both are
 * about this pair of notices:
 * - The raw access-control lines used to be pasted under the sentence. Four
 *   lines of `icacls` output in a toast close before they can be read, and the
 *   owner who needs them can open the Forge log at any time — so the detail
 *   goes there now, and the notice stays the one sentence that is decidable.
 * - `void showInformationMessage(...)` threw the answer away, so `Unlock it
 *   again` printed and did nothing when pressed. The choice is awaited now, and
 *   it runs the opposite COMMAND rather than a copy of its body: that command
 *   reports the state it reads back off the file afterwards, which is the only
 *   thing a lock claim can be checked against, and it is what keeps this notice
 *   from asserting something the next click proved false.
 */
async function reportPolicyLock(
  report: PolicyLockReport,
  label: string,
  oppositeCommand: string,
): Promise<void> {
  getLogger().info(`Forge policy lock: ${report.policyPath} — ${report.detail}`);
  const choice = await vscode.window.showInformationMessage(
    `Forge: ${policyLockSentence(report)}`,
    label,
  );
  if (choice !== label) return;
  try {
    await vscode.commands.executeCommand(oppositeCommand);
  } catch (err) {
    // Say which step failed. Blaming the lock that just worked would be the wrong
    // report for a follow-up unlock that did not.
    void vscode.window.showErrorMessage(`Forge: ${label} failed — ${(err as Error).message}`);
  }
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
          await startBackend(deps.backend, deps.getConfig(), modelName);
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
        // With no model selected nothing restarts; say so, as /restartBackend
        // does, rather than reporting a ready backend (U20-03).
        if (!modelName) {
          await deps.backend.stopAll();
          deps.statusBar.setStopped(modelName);
          void vscode.window.showInformationMessage(
            'Forge: all backends stopped. Pick a model to start again.',
          );
          return;
        }
        await restartBackend(deps.backend, deps.getConfig(), modelName);
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
      // `/config` lands here, and the owner asking "what does my config say" needs
      // the one thing config.yaml cannot answer: whether the file that says what an
      // agent may do is protected, and from whom. Read from the file rather than
      // from memory, so a lock set by another window — or by hand, or by an
      // elevated prompt — shows up here as the state it actually is.
      const report = readPolicyLockState(defaultPolicyPath());
      void vscode.window.showInformationMessage(`Forge: ${policyLockSentence(report)}`);
    }),
    // Both lock commands are the owner's, and nothing in Forge calls them: a lock the
    // protected code could set could also be undone by it, which is the whole point
    // of locking. Each reports the state it READ BACK afterwards, because the change
    // lives in the file's permissions and not in anything Forge remembers.
    vscode.commands.registerCommand('forge.lockPolicy', async () => {
      try {
        const report = lockPolicyFile(defaultPolicyPath());
        await reportPolicyLock(report, 'Unlock it again', 'forge.unlockPolicy');
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Forge: could not lock policy.yaml — ${(err as Error).message}`,
        );
      }
    }),
    vscode.commands.registerCommand('forge.unlockPolicy', async () => {
      try {
        const report = unlockPolicyFile(defaultPolicyPath());
        await reportPolicyLock(report, 'Lock it again', 'forge.lockPolicy');
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Forge: could not unlock policy.yaml — ${(err as Error).message}`,
        );
      }
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
          // Group-resolved: `provider` is routinely inherited from a `group`,
          // and the raw entry carries none — every such model was labelled
          // "llama.cpp" here and routed as one below.
          description: mergeGroupsIntoModel(config, model).provider ?? 'llama.cpp',
          modelName: model.name,
        })),
        { placeHolder: 'Pick the Forge model to use' },
      );
      if (!pick) return;
      // F6: when request-time profiles exist, offer them as a second step. The
      // chosen base@profile becomes active_model; loading still keys on the base.
      const profileNames = availableProfilesFor(config, pick.modelName);
      let selectedId = pick.modelName;
      if (profileNames.length > 0) {
        // Every choice is a profile: a model that has profiles is always run
        // through one, so the second quick pick lists only the real profiles
        // and the chosen one always becomes `<model>@<profile>` (matching the
        // Telegram picker). Cancelling the pick still aborts.
        const profilePick = await vscode.window.showQuickPick(
          profileNames.map((p) => ({ label: p, profile: p })),
          { placeHolder: `Pick a profile for ${pick.modelName}` },
        );
        if (!profilePick) return;
        selectedId = `${pick.modelName}@${profilePick.profile}`;
      }
      const rawSelected = config.models.find((m) => m.name === pick.modelName);
      const selectedModel = rawSelected ? mergeGroupsIntoModel(config, rawSelected) : undefined;
      deps.statusBar.setStarting(selectedId);
      try {
        // Route native picking through the same conversation-aware transition
        // as the sidebar picker, so the outgoing local backend is released
        // before this command acquires a replacement.
        await deps.sidebar.switchModel(selectedId);
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
    // The healthy-path half of a pair: the failed-load half is registered by
    // `policyMigrationRecovery.ts` from inside `configBootstrap.ts`, and only one
    // of the two can run in a window — `extension.ts:87` returns before this file
    // when the config would not load. Move either side and check that still holds.
    vscode.commands.registerCommand('forge.movePolicy', async () => {
      const configPath = deps.getConfigPath();
      try {
        const result = runPolicyMigration(configPath);
        deps.setConfig(loadConfig(path.dirname(configPath)));
        const keys =
          result.movedKeys.length > 0
            ? `moved ${result.movedKeys.length} policy key(s): ${result.movedKeys.join(', ')}`
            : 'found no policy key left in config.yaml';
        const engines =
          result.engines.length > 0
            ? ` and wrote ${result.engines.length} engine(s): ${result.engines
                .map((row) => row.name)
                .join(', ')}`
            : '';
        void vscode.window.showInformationMessage(
          `Forge: ${keys}${engines} into ${result.policyPath}. Backup: ${result.backupPath}.` +
            (result.policyWritten
              ? ''
              : '\npolicy.yaml already held exactly this content, so it was left untouched; ' +
                'the config side of the move is now finished.') +
            (result.model_hosts.length > 0
              ? `\nmodel_hosts: ${result.model_hosts.join(', ')} — the hosts your models already ` +
                'talk to, so the phase-3 host rule does not refuse them.'
              : ''),
        );
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Forge: policy split failed — ${(err as Error).message}`,
        );
      }
    }),
    vscode.commands.registerCommand('forge.clearChat', () => {
      deps.sidebar.clearChat();
      void vscode.window.showInformationMessage('Forge: active chat cleared');
    }),
    vscode.commands.registerCommand('forge.unloadModel', async () => {
      try {
        const { model, wasLoaded } = await deps.sidebar.unloadConversationModel();
        if (wasLoaded) deps.statusBar.setStopped(model);
        void vscode.window.showInformationMessage(
          `Forge: ${model} ${wasLoaded ? 'unloaded' : 'was not loaded'}`,
        );
      } catch (err) {
        void vscode.window.showErrorMessage(`Forge: ${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand('forge.unloadAllModels', async () => {
      const modelName = deps.getConfig().active_model;
      try {
        await deps.sidebar.unloadModels();
        deps.statusBar.setStopped(modelName);
        void vscode.window.showInformationMessage('Forge: all models unloaded');
      } catch (err) {
        const message = (err as Error).message;
        deps.statusBar.setError(message);
        void vscode.window.showErrorMessage(`Forge: ${message}`);
      }
    }),
  );
  registerEditorCommands(context, deps);
  registerAgentBusCommands(context);
}
