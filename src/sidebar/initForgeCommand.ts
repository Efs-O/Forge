import * as path from 'path';
import * as vscode from 'vscode';
import {
  ensureForgeInstructionsFile,
  resolveInstructionScopeRoot,
} from '../llm/ForgeInstructionsLoader';
import type { SlashCommandDeps } from './SlashCommandHandler';

/**
 * `/init` (alias `/initForge`): make sure FORGE.md exists, then hand the agent
 * an ordinary turn to fill it in. The agent can run the commands it writes
 * down, which a one-shot no-tools prompt never could, and its edits go
 * through the confirmation gate and the turn checkpoint like any other.
 */
export async function runInitForgeCommand(deps: SlashCommandDeps): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    void vscode.window.showWarningMessage(
      'Forge: no workspace folder open — cannot set up FORGE.md.',
    );
    return;
  }
  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
  const repositoryRoot = resolveInstructionScopeRoot(root, activeFile);
  const result = ensureForgeInstructionsFile(repositoryRoot);
  if (result.status === 'error') {
    void vscode.window.showErrorMessage(
      `Forge: could not create ${result.path} — ${result.error.message}`,
    );
    return;
  }
  await deps.submitPrompt(buildInitPrompt(path.relative(root, result.path) || result.path));
}

function buildInitPrompt(instructionsPath: string): string {
  return `Set up \`${instructionsPath}\`, the instructions file Forge adds to every prompt in this repository.

Read the repository first: its README, its build and package files, its test setup and its main source folders. Then edit \`${instructionsPath}\` in place:

- Fill the blank entries under "Project facts" and "Commands": what the project is, the important architecture decisions, and the exact build, test and full-gate commands. Write the full gate as one command line that chains its steps (for example \`npm run typecheck && npm test\`), so it runs in one call.
- Run each command before you write it down. Write down only facts that will still be true next month: never record test results, failing tests, the current branch, counts, dates or anything about the current working-tree state. If a command fails, find out why, and write it down only together with the permanent prerequisite it needs (for example "needs Docker running"); otherwise leave it out and say so in your reply.
- Add only facts a future session would otherwise spend a round discovering: where the main code lives, conventions the code follows, traps you hit. Nothing a single file listing already shows.
- Keep the existing working rules unless one plainly does not fit this project.
- Never delete or rewrite text a person wrote. If the file already has project content, only add what is missing.
- Keep the whole file around 4 KB. It is paid on every turn.

Change no other file. When done, reply with a short summary of what you added.`;
}
