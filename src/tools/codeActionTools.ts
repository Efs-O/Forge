import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';
import { resolveWorkspaceUri } from '../util/WorkspacePaths';

interface ListedCodeAction {
  title: string;
  kind?: string;
  disabled?: string;
  has_edit: boolean;
}

async function codeActions(
  path: string,
  line: number,
  character: number,
): Promise<vscode.CodeAction[]> {
  const uri = resolveWorkspaceUri(path);
  await vscode.workspace.openTextDocument(uri);
  const position = new vscode.Position(line, character);
  return (
    (await vscode.commands.executeCommand<vscode.CodeAction[] | undefined>(
      'vscode.executeCodeActionProvider',
      uri,
      new vscode.Range(position, position),
    )) ?? []
  );
}

/** Lists LSP quick fixes without executing provider commands or making edits. */
export function makeGetCodeActionsTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'get_code_actions',
        description: 'List available LSP code actions at a zero-based position in a file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path, absolute or workspace-relative.' },
            line: { type: 'integer', minimum: 0, description: 'Zero-based line number.' },
            character: { type: 'integer', minimum: 0, description: 'Zero-based character offset.' },
          },
          required: ['path', 'line', 'character'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args) => {
      const actions = await codeActions(
        args['path'] as string,
        args['line'] as number,
        args['character'] as number,
      );
      const listed: ListedCodeAction[] = actions.map((action) => ({
        title: action.title,
        ...(action.kind ? { kind: action.kind.value } : {}),
        ...(action.disabled ? { disabled: action.disabled.reason } : {}),
        has_edit: action.edit !== undefined,
      }));
      return JSON.stringify({ actions: listed });
    },
  };
}

/** Applies only code actions represented as a WorkspaceEdit; arbitrary commands stay out of scope. */
export function makeApplyCodeActionTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'apply_code_action',
        description:
          'Apply an editable LSP code action identified by its exact title at a zero-based position. ' +
          'Use get_code_actions first. Actions that require an arbitrary VS Code command are refused.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path, absolute or workspace-relative.' },
            line: { type: 'integer', minimum: 0, description: 'Zero-based line number.' },
            character: { type: 'integer', minimum: 0, description: 'Zero-based character offset.' },
            title: {
              type: 'string',
              minLength: 1,
              description: 'Exact title returned by get_code_actions.',
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
      const actions = await codeActions(
        args['path'] as string,
        args['line'] as number,
        args['character'] as number,
      );
      const action = actions.find((candidate) => candidate.title === args['title']);
      if (!action)
        throw new Error(`apply_code_action: no current action titled "${args['title']}".`);
      if (action.disabled) throw new Error(`apply_code_action: ${action.disabled.reason}`);
      if (!action.edit || action.command) {
        throw new Error('apply_code_action: this action is not a workspace-edit-only action.');
      }
      const changedPaths = action.edit
        .entries()
        .map(([uri]) => uri.fsPath)
        .filter((filePath) => filePath.length > 0);
      context?.beforeMutate(changedPaths);
      if (!(await vscode.workspace.applyEdit(action.edit))) {
        throw new Error('apply_code_action: VS Code rejected the workspace edit.');
      }
      return `Applied code action: ${action.title}`;
    },
  };
}
