import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';
import { resolveRealWorkspacePath, resolveWorkspaceUri } from '../util/WorkspacePaths';
import { applyAndSaveWorkspaceEdit } from './workspaceEditApply';

interface ListedCodeAction {
  title: string;
  kind?: string;
  disabled?: string;
  applies: boolean;
}

interface CodeActionsResult {
  actions: vscode.CodeAction[];
  diagnosticsWaitTimedOut: boolean;
  diagnosticsStillEmpty: boolean;
}

export interface DiagnosticsReadyResult<T> {
  result: T;
  diagnosticsWaitTimedOut: boolean;
  diagnosticsStillEmpty: boolean;
}

const DIAGNOSTICS_WAIT_MS = 4_000;

function isBookkeepingOnlyCommand(command: vscode.Command | undefined): boolean {
  if (!command) return true;
  if (command.command !== '_typescript.applyCodeActionCommand') return false;

  const payload = command.arguments?.[0] as { action?: { commands?: unknown } } | undefined;
  const commands = payload?.action?.commands;
  return commands === undefined || (Array.isArray(commands) && commands.length === 0);
}

/** Whether Forge can safely apply an action by applying its WorkspaceEdit alone. */
function codeActionApplies(
  action: vscode.CodeAction,
): action is vscode.CodeAction & { edit: vscode.WorkspaceEdit } {
  return (
    action.edit !== undefined &&
    action.disabled === undefined &&
    isBookkeepingOnlyCommand(action.command)
  );
}

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
        if (
          event.uris.some((changedUri) => changedUri.toString() === uri.toString()) &&
          vscode.languages.getDiagnostics(uri).length > 0
        ) {
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

/** Load a document and make TypeScript diagnostics/quick fixes eligible by opening a tab. */
export async function withDiagnosticsReady<T>(
  uri: vscode.Uri,
  run: (document: vscode.TextDocument) => Promise<T>,
): Promise<DiagnosticsReadyResult<T>> {
  const document = await vscode.workspace.openTextDocument(uri);
  const window = vscode.window;
  const tabGroups = window?.tabGroups;
  const canOpenTab =
    tabGroups &&
    typeof window?.showTextDocument === 'function' &&
    typeof tabGroups.close === 'function' &&
    typeof vscode.languages.onDidChangeDiagnostics === 'function';
  if (!canOpenTab) {
    const result = await run(document);
    return { result, diagnosticsWaitTimedOut: false, diagnosticsStillEmpty: false };
  }

  const existingTab = tabGroups.all
    .flatMap((group) => group.tabs)
    .find(
      (tab) =>
        tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString(),
    );
  let openedTab: vscode.Tab | undefined;
  if (!existingTab) {
    await window.showTextDocument(document, {
      preview: false,
      preserveFocus: true,
      viewColumn: vscode.ViewColumn.Active,
    });
    openedTab = tabGroups.all
      .flatMap((group) => group.tabs)
      .find(
        (tab) =>
          tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString(),
      );
  }

  let diagnosticsWaitTimedOut = false;
  try {
    if (vscode.languages.getDiagnostics(uri).length === 0) {
      diagnosticsWaitTimedOut = await waitForDiagnostics(uri);
    }
    const result = await run(document);
    const diagnosticsStillEmpty =
      diagnosticsWaitTimedOut && vscode.languages.getDiagnostics(uri).length === 0;
    return { result, diagnosticsWaitTimedOut, diagnosticsStillEmpty };
  } finally {
    if (openedTab && !document.isDirty) await tabGroups.close(openedTab, true);
  }
}

async function codeActions(
  path: string,
  line: number,
  character: number,
  requestedPath = path,
  toolName = 'code_intel code_actions',
  afterQuery?: (actions: vscode.CodeAction[]) => Promise<void>,
): Promise<CodeActionsResult> {
  const uri = resolveWorkspaceUri(path);
  const ready = await withDiagnosticsReady(uri, async (document) => {
    const position = new vscode.Position(line, character);
    let actions: vscode.CodeAction[];
    try {
      actions =
        (await vscode.commands.executeCommand<vscode.CodeAction[] | undefined>(
          'vscode.executeCodeActionProvider',
          document.uri,
          new vscode.Range(position, position),
        )) ?? [];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${toolName} failed at ${requestedPath}:${line}:${character} (zero-based): VS Code said "${message}". ` +
          'Check the position is on code (read_file the line), or use code_intel diagnostics to see what the language server reports for this file.',
      );
    }
    await afterQuery?.(actions);
    return actions;
  });
  return {
    actions: ready.result,
    diagnosticsWaitTimedOut: ready.diagnosticsWaitTimedOut,
    diagnosticsStillEmpty: ready.diagnosticsStillEmpty,
  };
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
    applies: codeActionApplies(action),
  }));
  return JSON.stringify({
    actions: listed,
    ...(result.diagnosticsWaitTimedOut && result.diagnosticsStillEmpty
      ? {
          note: 'No problems are reported for this file even after Forge opened it in an editor tab and waited 4 s, so quick fixes (such as adding a missing import) may be missing. Ask again in a few seconds, or make the change with edit_file.',
        }
      : {}),
  });
}

/** Applies code actions as WorkspaceEdits without executing provider commands. */
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
          'Use code_intel with operation "code_actions" first. Only actions that code_intel lists with "applies": true can be applied.',
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
      await codeActions(
        filePath,
        args['line'] as number,
        args['character'] as number,
        args['path'] as string,
        'apply_code_action',
        async (actions) => {
          const action = actions.find((candidate) => candidate.title === args['title']);
          if (!action) {
            const applicableTitles = [
              ...new Set(actions.filter(codeActionApplies).map((candidate) => candidate.title)),
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
          if (!codeActionApplies(action)) {
            if (action.command && !isBookkeepingOnlyCommand(action.command)) {
              throw new Error(
                `apply_code_action: "${action.title}" runs the VS Code command ${action.command.command}, which Forge does not run. Make the change with edit_file.`,
              );
            }
            throw new Error(
              `apply_code_action: "${action.title}" carries no edit. Make the change with edit_file.`,
            );
          }
          await applyAndSaveWorkspaceEdit('apply_code_action', action.edit, extraRoots(), context);
        },
      );
      return `Applied code action: ${args['title'] as string}`;
    },
  };
}
