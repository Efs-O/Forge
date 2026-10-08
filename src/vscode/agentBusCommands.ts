import * as vscode from 'vscode';
import { readClaudeSessions } from '../agentBus/claudePeer';

/**
 * Copies the selected live Claude session id for use with `/link`.
 */
export function registerAgentBusCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('forge.listClaudeSessions', async () => {
      const sessions = readClaudeSessions();
      if (sessions.length === 0) {
        void vscode.window.showInformationMessage(
          'Forge: no Claude Code session is running (or none has messaging on).',
        );
        return;
      }
      const pick = await vscode.window.showQuickPick(
        sessions.map((s) => ({
          label: s.sessionId ?? s.name,
          description: `${s.name} · ${s.status}${s.sdk ? ' · SDK' : ''}`,
          detail: s.cwd,
        })),
        { title: 'Live Claude Code sessions', placeHolder: 'Pick one to copy its session id' },
      );
      if (!pick) return;
      await vscode.env.clipboard.writeText(pick.label);
      void vscode.window.showInformationMessage(`Forge: copied "${pick.label}".`);
    }),
  );
}
