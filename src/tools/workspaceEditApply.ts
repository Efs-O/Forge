import * as vscode from 'vscode';
import type { ToolHandlerContext } from './ToolRegistry';
import { resolveRealWorkspacePath } from '../util/WorkspacePaths';

/**
 * Apply a language-server `WorkspaceEdit` the way `format_file` applies its
 * own: every target inside the workspace or an `extra_file_roots` folder
 * (U15-03/04), no target holding unsaved user edits, then apply and save.
 * Saving is what lets the per-turn checkpoint see the change — Undo restores
 * disk, so an applied-but-unsaved edit stayed in the buffer after Undo
 * reported success (U15-02).
 */
export async function applyAndSaveWorkspaceEdit(
  tool: string,
  edit: vscode.WorkspaceEdit,
  extraRoots: readonly string[],
  context: ToolHandlerContext | undefined,
): Promise<void> {
  const uris = edit.entries().map(([uri]) => uri);
  for (const uri of uris) {
    if (uri.scheme !== 'file') {
      throw new Error(`${tool}: the edit targets ${uri.toString()}, which is not a file on disk`);
    }
    await resolveRealWorkspacePath(uri.fsPath, undefined, { allowMissing: true, extraRoots });
  }
  const docs = await Promise.all(uris.map((uri) => vscode.workspace.openTextDocument(uri)));
  const dirty = docs.filter((doc) => doc.isDirty).map((doc) => relative(doc));
  if (dirty.length > 0) {
    throw new Error(
      `${tool}: ${dirty.join(', ')} has unsaved editor changes; refusing to save unrelated user edits`,
    );
  }
  context?.beforeMutate(uris.map((uri) => uri.fsPath));
  if (!(await vscode.workspace.applyEdit(edit))) {
    throw new Error(`${tool}: VS Code rejected the workspace edit`);
  }
  const unsaved: string[] = [];
  for (const doc of docs) if (!(await doc.save())) unsaved.push(relative(doc));
  if (unsaved.length > 0) {
    throw new Error(
      `${tool}: applied, but ${unsaved.join(', ')} could not be saved; ` +
        'the change is present in the editor buffer only',
    );
  }
}

function relative(doc: vscode.TextDocument): string {
  return vscode.workspace.asRelativePath(doc.uri);
}
