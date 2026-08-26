import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';
import { resolveWorkspaceUri } from '../util/WorkspacePaths';
import { capResultText, MAX_READ_FILE_CHARS } from './resultCap';

function notebookUri(path: string): vscode.Uri {
  return resolveWorkspaceUri(path);
}

export function makeReadNotebookTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'read_notebook',
        description:
          'Read a notebook’s cells, source, language, and outputs summary. Use cell_index to read one cell.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Notebook path, absolute or workspace-relative.' },
            cell_index: {
              type: 'integer',
              minimum: 0,
              description: 'Optional zero-based cell index.',
            },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args) => {
      const document = await vscode.workspace.openNotebookDocument(
        notebookUri(args['path'] as string),
      );
      const requested = args['cell_index'] as number | undefined;
      const cells =
        requested === undefined ? [...document.getCells()] : [document.cellAt(requested)];
      const value = {
        cell_count: document.cellCount,
        cells: cells.map((cell) => ({
          index: cell.index,
          kind: cell.kind === vscode.NotebookCellKind.Code ? 'code' : 'markup',
          language: cell.document.languageId,
          source: cell.document.getText(),
          output_count: cell.outputs.length,
        })),
      };
      return capResultText(JSON.stringify(value), MAX_READ_FILE_CHARS, 'read_notebook');
    },
  };
}

export function makeEditNotebookCellTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'edit_notebook_cell',
        description:
          'Replace the source of one existing notebook cell. This preserves the cell kind and metadata.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Notebook path, absolute or workspace-relative.' },
            cell_index: { type: 'integer', minimum: 0, description: 'Zero-based cell index.' },
            source: { type: 'string', description: 'New complete source for the cell.' },
          },
          required: ['path', 'cell_index', 'source'],
          additionalProperties: false,
        },
      },
    },
    permission: 'write',
    mutation: { paths: (args) => [args['path'] as string], showDiff: false },
    handler: async (args) => {
      const uri = notebookUri(args['path'] as string);
      const document = await vscode.workspace.openNotebookDocument(uri);
      const index = args['cell_index'] as number;
      if (index >= document.cellCount) {
        throw new Error(
          `edit_notebook_cell: cell_index ${index} is outside this ${document.cellCount}-cell notebook.`,
        );
      }
      const previous = document.cellAt(index);
      const replacement = new vscode.NotebookCellData(
        previous.kind,
        args['source'] as string,
        previous.document.languageId,
      );
      replacement.metadata = previous.metadata;
      const edit = new vscode.WorkspaceEdit();
      edit.set(uri, [
        vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(index, index + 1), [replacement]),
      ]);
      if (!(await vscode.workspace.applyEdit(edit))) {
        throw new Error('edit_notebook_cell: VS Code rejected the notebook edit.');
      }
      return `Updated notebook cell ${index}.`;
    },
  };
}
