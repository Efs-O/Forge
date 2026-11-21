import * as vscode from 'vscode';
import type { BackendStatusBar } from '../vscode/BackendStatusBar';
import { runFirstRunWizard } from './FirstRunWizard';
import { SidebarProvider } from './SidebarProvider';
import { SETUP_WITH_AGENT_COMMAND } from '../vscode/agentSetupCommand';
import { resolveCliExecutable } from '../agents/resolveCliExecutable';
import type { CliAgentName } from '../agents/types';

/** Display names for the setup screen, in the order they are tried. */
export const SETUP_AGENT_LABELS: Readonly<Record<CliAgentName, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'GitHub Copilot',
};

/** The same order as `SETUP_AGENT_LABELS`: claude, then codex, then copilot. */
const SETUP_AGENT_ORDER = Object.keys(SETUP_AGENT_LABELS) as CliAgentName[];

/** The first coding agent CLI on PATH (claude, then codex, then copilot), or
 *  undefined. Runs on every activation; nothing is cached, so an agent
 *  installed later is found on the next start. */
export async function detectSetupAgent(
  resolve: (cli: string, name: CliAgentName) => Promise<string> = resolveCliExecutable,
): Promise<CliAgentName | undefined> {
  for (const name of SETUP_AGENT_ORDER) {
    try {
      await resolve(name, name);
      return name;
    } catch {
      // A miss is an answer, not an error: with no config this runs on every
      // activation, so an absent agent must never reach the log. Try the next.
    }
  }
  return undefined;
}

const BUTTON_STYLE = 'padding:8px 16px;cursor:pointer;';

/** The placeholder webview. `detecting` while the PATH lookup is still running,
 *  then the agent it found, or `undefined` when nothing was found. The found
 *  agent is the one primary button and the wizard a link under it; with no
 *  agent the wizard is primary and the AI setup prompt the link. */
export function setupPlaceholderHtml(agent: CliAgentName | undefined | 'detecting'): string {
  const parts: string[] = [];
  if (agent === 'detecting') {
    parts.push('<p>Looking for Claude Code, Codex or Copilot…</p>');
  } else if (agent !== undefined) {
    const label = SETUP_AGENT_LABELS[agent];
    parts.push(
      `<button onclick="vscode.postMessage({type:'agent'})" style="${BUTTON_STYLE}">Set up with an AI agent</button>`,
      `<p style="margin-top:12px;font-size:90%;">Found ${label} on this PC. The button copies a setup prompt to paste into it.</p>`,
      `<a href="#" onclick="vscode.postMessage({type:'wizard'})">Set up without an AI agent</a>`,
    );
  } else {
    parts.push(
      `<button onclick="vscode.postMessage({type:'wizard'})" style="${BUTTON_STYLE}">Run Setup Wizard</button>`,
      `<a href="#" onclick="vscode.postMessage({type:'agent'})">Copy the AI agent setup prompt instead</a>`,
    );
  }
  return `<!DOCTYPE html><html><body style="padding:20px;font-family:sans-serif;">
      <p style="margin-bottom:12px;">No <code>config.yaml</code> found.</p>
      ${parts.join('\n      ')}
      <script>const vscode = acquireVsCodeApi();</script>
    </body></html>`;
}

class SetupPlaceholderProvider implements vscode.WebviewViewProvider {
  constructor(private readonly agent: Promise<CliAgentName | undefined>) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    view.webview.html = setupPlaceholderHtml('detecting');
    // `detectSetupAgent` never rejects, so this only ever swaps in the real screen.
    void this.agent.then((found) => {
      view.webview.html = setupPlaceholderHtml(found);
    });
    view.webview.onDidReceiveMessage((message) => {
      if (message.type === 'wizard') void vscode.commands.executeCommand('forge.setupWizard');
      if (message.type === 'agent') void vscode.commands.executeCommand(SETUP_WITH_AGENT_COMMAND);
    });
  }
}

export function enterSetupMode(
  context: vscode.ExtensionContext,
  statusBar: BackendStatusBar,
  message: string,
): void {
  // One PATH lookup feeds both the sidebar screen and the toast: the screen can
  // paint while the toast waits for the same answer.
  const agent = detectSetupAgent();
  statusBar.setNoConfig();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarProvider.viewId,
      new SetupPlaceholderProvider(agent),
    ),
    // The wizard offers the reload itself, after its setup check: reloading here
    // too would fire after "Open config" or a dismissed warning as well.
    vscode.commands.registerCommand('forge.setupWizard', async () => {
      await runFirstRunWizard(context);
    }),
  );
  void agent.then(async (found) => {
    const wizardLabel = 'Setup Wizard';
    const agentLabel = 'Set up with an AI agent';
    const buttons = found ? [agentLabel, wizardLabel] : [wizardLabel, agentLabel];
    const choice = await vscode.window.showInformationMessage(message, ...buttons);
    if (choice === wizardLabel) void vscode.commands.executeCommand('forge.setupWizard');
    else if (choice === agentLabel) void vscode.commands.executeCommand(SETUP_WITH_AGENT_COMMAND);
  });
}
