import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';
import { resolveRealWorkspacePath, resolveWorkspaceUri } from '../util/WorkspacePaths';
import { applyAndSaveWorkspaceEdit } from './workspaceEditApply';

interface ListedCodeAction {
  title: string;
  kind?: string;
  disabled?: string;
  has_edit: boolean;
}

interface CodeActionsResult {
  actions: vscode.CodeAction[];
  diagnosticsWaitTimedOut: boolean;
  diagnosticsStillEmpty: boolean;
}

const DIAGNOSTICS_WAIT_MS = 2_000;

async function waitForDiagnostics(uri: vscode.Uri): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let subscription: vscode.Disposable | undefined;
    const finish = (timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      subscription?.dispose();
      resolve(timedOut);
    };
    const timeout = setTimeout(() => finish(true), DIAGNOSTICS_WAIT_MS);
    try {
      subscription = vscode.languages.onDidChangeDiagnostics((event) => {
        if (event.uris.some((changedUri) => changedUri.toString() === uri.toString())) {
          finish(false);
        }
      });
      if (settled) subscription.dispose();
    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }
  });
}

async function codeActions(
  path: string,
  line: number,
  character: number,
  requestedPath = path,
  toolName = 'code_intel code_actions',
): Promise<CodeActionsResult> {
  const uri = resolveWorkspaceUri(path);
  const wasOpen = (vscode.workspace.textDocuments ?? []).some(
    (openDocument) => openDocument.uri.toString() === uri.toString(),
  );
  const document = await vscode.workspace.openTextDocument(uri);
  let diagnosticsWaitTimedOut = false;
  if (
    !wasOpen &&
    vscode.languages.getDiagnostics(document.uri).length === 0 &&
    typeof vscode.languages.onDidChangeDiagnostics === 'function'
  ) {
    diagnosticsWaitTimedOut = await waitForDiagnostics(document.uri);
  }
  const diagnosticsStillEmpty =
    diagnosticsWaitTimedOut && vscode.languages.getDiagnostics(document.uri).length === 0;
  const position = new vscode.Position(line, character);
  try {
    const actions =
      (await vscode.commands.executeCommand<vscode.CodeAction[] | undefined>(
        'vscode.executeCodeActionProvider',
        document.uri,
        new vscode.Range(position, position),
      )) ?? [];
    return { actions, diagnosticsWaitTimedOut, diagnosticsStillEmpty };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${toolName} failed at ${requestedPath}:${line}:${character} (zero-based): VS Code said "${message}". ` +
        'Check the position is on code (read_file the line), or use code_intel diagnostics to see what the language server reports for this file.',
    );
  }
}

/** Lists LSP quick fixes without executing provider commands or making edits. */
export async function getCodeActions(args: Record<string, unknown>): Promise<string> {
  const result = await codeActions(
    args['path'] as string,
    args['line'] as number,
    args['character'] as number,
  );
  const listed: ListedCodeAction[] = result.actions.map((action) => ({
    title: action.title,
    ...(action.kind ? { kind: action.kind.value } : {}),
    ...(action.disabled ? { disabled: action.disabled.reason } : {}),
    has_edit: action.edit !== undefined,
  }));
  return JSON.stringify({
    actions: listed,
    ...(result.diagnosticsWaitTimedOut && result.diagnosticsStillEmpty
      ? {
          note: 'No problems are reported for this file yet, so quick fixes (such as adding a missing import) may be missing. If you expect one, open_file the file and ask again.',
        }
      : {}),
  });
}

/** Applies only code actions represented as a WorkspaceEdit; arbitrary commands stay out of scope. */
export function makeApplyCodeActionTool(
  extraRoots: () => readonly string[] = () => [],
): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'apply_code_action',
        description:
          'Apply an editable LSP code action identified by its exact title at a zero-based position. ' +
          'Use code_intel with operation "code_actions" first. Actions that require an arbitrary VS Code command are refused.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path, absolute or workspace-relative.' },
            line: { type: 'integer', minimum: 0, description: 'Zero-based line number.' },
            character: { type: 'integer', minimum: 0, description: 'Zero-based character offset.' },
            title: {
              type: 'string',
              minLength: 1,
              description: 'Exact title returned by code_intel with operation "code_actions".',
            },
          },
          required: ['path', 'line', 'character', 'title'],
          additionalProperties: false,
        },
      },
    },
    permission: 'write',
    mutation: { paths: (args) => [args['path'] as string], showDiff: true },
    handler: async (args, context) => {
      const filePath = await resolveRealWorkspacePath(args['path'] as string, undefined, {
        extraRoots: extraRoots(),
      });
      const { actions } = await codeActions(
        filePath,
        args['line'] as number,
        args['character'] as number,
        args['path'] as string,
        'apply_code_action',
      );
      const action = actions.find((candidate) => candidate.title === args['title']);
      if (!action) {
        const applicableTitles = [
          ...new Set(
            actions
              .filter((candidate) => candidate.edit && !candidate.command && !candidate.disabled)
              .map((candidate) => candidate.title),
          ),
        ];
        const location = `${args['path'] as string}:${args['line'] as number}:${args['character'] as number} (zero-based)`;
        if (applicableTitles.length) {
          const titles = applicableTitles.map((title) => `"${title}"`).join(', ');
          throw new Error(
            `apply_code_action: no current action titled "${args['title']}" at ${location}. Actions it can apply there now: ${titles}. Pass one of these titles exactly, or make the change with edit_file.`,
          );
        }
        throw new Error(
          `apply_code_action: no current action titled "${args['title']}" at ${location}, and no action it can apply is offered there now. Make the change with edit_file.`,
        );
      }
      if (action.disabled) throw new Error(`apply_code_action: ${action.disabled.reason}`);
      if (!action.edit || action.command) {
        throw new Error('apply_code_action: this action is not a workspace-edit-only action.');
      }
      await applyAndSaveWorkspaceEdit('apply_code_action', action.edit, extraRoots(), context);
      return `Applied code action: ${action.title}`;
    },
  };
}
