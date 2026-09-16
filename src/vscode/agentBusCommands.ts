import * as vscode from 'vscode';
import { busPaths, ensureBus } from '../agentBus/agentBus';
import { armPrompt } from '../agentBus/busContent';

/**
 * "Forge: Copy Claude Bus Prompt": the self-contained prompt that turns any
 * open Claude Code session into an agent-bus listener. A new user's Claude has
 * no memory of the protocol, so the prompt carries all of it.
 */
export function registerAgentBusCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('forge.copyClaudeBusPrompt', async () => {
      const paths = busPaths();
      ensureBus(paths);
      await vscode.env.clipboard.writeText(armPrompt(paths.root));
      void vscode.window.showInformationMessage(
        'Forge: bus prompt copied. Paste it into an open Claude Code session to start listening.',
      );
    }),
  );
}
