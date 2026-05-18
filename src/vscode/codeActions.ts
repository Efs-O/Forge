import * as vscode from 'vscode';

export class ForgeCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    return context.diagnostics.flatMap((diagnostic) => {
      const explain = new vscode.CodeAction('Forge: Explain Diagnostic', vscode.CodeActionKind.QuickFix);
      explain.command = {
        command: 'forge.explainDiagnostic',
        title: 'Forge: Explain Diagnostic',
        arguments: [document.uri, diagnostic],
      };

      const fix = new vscode.CodeAction('Forge: Propose Fix For Diagnostic', vscode.CodeActionKind.QuickFix);
      fix.command = {
        command: 'forge.fixDiagnostic',
        title: 'Forge: Propose Fix For Diagnostic',
        arguments: [document.uri, diagnostic],
      };

      return [explain, fix];
    });
  }
}
