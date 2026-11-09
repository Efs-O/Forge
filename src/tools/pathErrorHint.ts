import * as vscode from 'vscode';
import { formatPathMiss } from './pathMissText';

export function describePathMiss(tool: string, requestedPath: string, err: unknown): string {
  return formatPathMiss(
    tool,
    requestedPath,
    err,
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  );
}
