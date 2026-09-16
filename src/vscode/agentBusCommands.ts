import * as vscode from 'vscode';
import { readClaudeSessions } from '../agentBus/claudePeer';

/**
 * "Forge: Show Live Claude Sessions": the sessions `ask_live_session` can
 * reach, as the registry sees them. Picking one copies its name, for
 * `agent_bus.claude_session` or for telling the agent which one to ask.
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
          label: s.name,
          description: `${s.status}${s.sdk ? ' · SDK' : ''}`,
          detail: s.cwd,
        })),
        { title: 'Live Claude Code sessions', placeHolder: 'Pick one to copy its name' },
      );
      if (!pick) return;
      await vscode.env.clipboard.writeText(pick.label);
      void vscode.window.showInformationMessage(`Forge: copied "${pick.label}".`);
    }),
  );
}
