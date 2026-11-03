import * as vscode from 'vscode';
import { KeepUndoCodeLensProvider } from '../sidebar/KeepUndoCodeLens';
import { DiffDecorations } from '../sidebar/DiffDecorations';
import type { SidebarProvider } from '../sidebar/SidebarProvider';

export interface KeepUndoSetup {
  diffDecorations: DiffDecorations;
  codeLensProvider: KeepUndoCodeLensProvider;
}

/** Register the editor affordances for per-turn Keep and Undo. */
export function setupKeepUndo(
  context: vscode.ExtensionContext,
  getSidebarProvider: () => SidebarProvider,
): KeepUndoSetup {
  const diffDecorations = new DiffDecorations();
  context.subscriptions.push(diffDecorations);

  const codeLensProvider = new KeepUndoCodeLensProvider(
    () => {
      void getSidebarProvider().keep();
    },
    () => {
      void getSidebarProvider().undo();
    },
    diffDecorations,
  );
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLensProvider),
    codeLensProvider,
  );
  return { diffDecorations, codeLensProvider };
}
