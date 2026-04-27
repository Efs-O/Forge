import * as vscode from 'vscode';

export interface ConfirmResult {
  approved: boolean;
  remember: boolean;
}

/**
 * Shows a modal confirmation dialog before a tool runs.
 * Returns approved=true if user clicked Run, false if Cancel.
 * remember=true if user clicked "Always allow this session".
 */
export async function confirmToolCall(
  toolName: string,
  detail: string,
  isDangerous: boolean,
): Promise<ConfirmResult> {
  const runLabel         = isDangerous ? 'Run (I understand the risk)' : 'Run';
  const allowSessionLabel = 'Allow this session';

  const choices: string[] = isDangerous
    ? [runLabel]
    : [runLabel, allowSessionLabel];

  const choice = await vscode.window.showWarningMessage(
    isDangerous
      ? `⚠️ DANGEROUS: ${toolName}\n${detail}`
      : `Forge wants to run: ${toolName}\n${detail}`,
    { modal: true },
    ...choices,
  );

  if (!choice) return { approved: false, remember: false };
  return {
    approved: true,
    remember: choice === allowSessionLabel,
  };
}
