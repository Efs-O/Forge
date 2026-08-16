/**
 * Commands that act on what is open in the editor: selections, tabs,
 * diagnostics, and Markdown scratch drafts.
 *
 * Split out of `nativeCommands.ts`, which keeps the backend/config commands.
 */

import * as vscode from 'vscode';
import type { NativeCommandDeps } from './commandDeps';
import {
  activeFileBlock,
  activeSelectionBlock,
  diagnosticsForActiveFile,
  formatContextBlocks,
  openTabBlocks,
  pickFileBlocks,
} from './editorContext';
import {
  draftScratch,
  prefillBlocks,
  prefillDiagnostic,
  prefillManyBlocks,
  prefillSelection,
  runDiagnosticPrompt,
  runSelectionPrompt,
} from './commandHelpers';

export function registerEditorCommands(
  context: vscode.ExtensionContext,
  deps: NativeCommandDeps,
): void {
  context.subscriptions.push(
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
