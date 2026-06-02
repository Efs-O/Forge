import * as vscode from 'vscode';
import type { ControlServer } from '../backend/ControlServer';

/**
 * Command-palette entries that drive the same model-control logic as the HTTP
 * control API (ensure / release / status). They work whether or not the HTTP
 * listener is enabled, since they call the in-process ControlServer directly.
 */
export function registerControlServerCommands(
  context: vscode.ExtensionContext,
  controlServer: ControlServer,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('forge.ensureModel', async () => {
      const status = controlServer.status();
      const pick = await vscode.window.showQuickPick(
        status.models.map((m) => ({
          label: m.name,
          description: `${m.backend}${m.loaded ? ' • loaded' : ''}${m.holds ? ` • held×${m.holds}` : ''}`,
        })),
        { title: 'Forge: Ensure Model (load on demand)', placeHolder: 'Select a model to load + warm' },
      );
      if (!pick) return;

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Forge: ensuring ${pick.label}…` },
        async () => {
          const res = await controlServer.ensureModel(pick.label);
          if ('error' in res.body) {
            void vscode.window.showErrorMessage(`Forge: ${res.body.error}`);
          } else {
            void vscode.window.showInformationMessage(`Forge: ${res.body.model} ready at ${res.body.baseUrl}`);
          }
        },
      );
    }),

    vscode.commands.registerCommand('forge.releaseModel', async () => {
      const active = controlServer.status().models.filter((m) => m.loaded || m.holds > 0);
      if (active.length === 0) {
        void vscode.window.showInformationMessage('Forge: no loaded/held models to release.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        active.map((m) => ({
          label: m.name,
          description: `${m.loaded ? 'loaded' : ''}${m.holds ? ` • held×${m.holds}` : ''}`,
        })),
        { title: 'Forge: Release Model', placeHolder: 'Select a model to release one hold' },
      );
      if (!pick) return;

      const released = controlServer.releaseHold(pick.label);
      void vscode.window.showInformationMessage(
        released ? `Forge: released one hold on ${pick.label}` : `Forge: ${pick.label} had no active holds`,
      );
    }),

    vscode.commands.registerCommand('forge.controlServerStatus', () => {
      const s = controlServer.status();
      const active = s.models
        .filter((m) => m.loaded || m.holds > 0)
        .map((m) => `${m.name}${m.holds ? ` (held×${m.holds})` : ''}`);
      const where = s.listening
        ? `listening on http://127.0.0.1:${s.port}`
        : 'not listening (set control_server.enabled: true)';
      void vscode.window.showInformationMessage(
        `Forge control server: ${where}. ${active.length ? `Active: ${active.join(', ')}` : 'No models loaded.'}`,
      );
    }),
  );
}
