import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { HostToWebview } from './messageBridge';
import { computeDiff } from './DiffUtils';
import type { ChatMessage, ToolCall } from '../llm/types';
import type { CheckpointStack } from '../checkpoint/CheckpointStack';
import type { KeepUndoCodeLensProvider } from './KeepUndoCodeLens';
import type { ToolPermission } from '../tools/ToolRegistry';
import { ToolRegistry } from '../tools/ToolRegistry';
import { ToolFailureTracker } from '../tools/StripTools';
import type { DiffDecorations } from './DiffDecorations';

const WRITE_PERMISSIONS = new Set<ToolPermission>(['write', 'delete']);

export function resolveToolPath(filePath: string): string {
  if (path.isAbsolute(filePath)) return path.normalize(filePath);
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder
    ? path.normalize(path.join(folder.uri.fsPath, filePath))
    : path.normalize(filePath);
}

export class ToolDispatch {
  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly checkpoints: CheckpointStack,
    private readonly codeLens: KeepUndoCodeLensProvider,
    private readonly failureTracker: ToolFailureTracker,
    private readonly post: (msg: HostToWebview) => void,
    private readonly requestApproval: (toolName: string, detail: string, isDangerous?: boolean, convId?: string) => Promise<boolean>,
    private readonly diffDecorations: DiffDecorations,
  ) {}

  async dispatch(
    toolCalls: ToolCall[],
    allowed: Set<ToolPermission>,
    messages: ChatMessage[],
    convId?: string,
  ): Promise<void> {
    for (const tc of toolCalls) {
      let result: string;
      let args: Record<string, unknown> | undefined;
      try {
        try {
          args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          this.failureTracker.record();
          result = `Error: malformed tool arguments (invalid JSON)`;
          this.postResult(tc, result, undefined, convId);
          messages.push({ role: 'tool', content: result, tool_call_id: tc.id, name: tc.function.name });
          continue;
        }

        const reg = this.toolRegistry.get(tc.function.name);
        if (!reg) {
          result = `Error: unknown tool "${tc.function.name}"`;
          this.postResult(tc, result, undefined, convId);
          messages.push({ role: 'tool', content: result, tool_call_id: tc.id, name: tc.function.name });
          continue;
        }

        const needsConfirm = WRITE_PERMISSIONS.has(reg.permission) || reg.permission === 'terminal' || reg.permission === 'git';
        if (needsConfirm) {
          const raw = JSON.stringify(args, null, 2);
          const detail = raw.length > 300 ? raw.slice(0, 300) + '\n…' : raw;
          const isDangerous = tc.function.name === 'delete_file' && args['recursive'] === true;
          const approved = await this.requestApproval(tc.function.name, detail, isDangerous, convId);
          if (!approved) {
            result = `User declined: ${tc.function.name}`;
            this.postResult(tc, result, undefined, convId);
            messages.push({ role: 'tool', content: result, tool_call_id: tc.id, name: tc.function.name });
            continue;
          }
        }

        if (reg.permission === 'write' || reg.permission === 'delete') {
          if (typeof args['path'] === 'string') this.checkpoints.snapshotBefore(resolveToolPath(args['path']));
          if (typeof args['filepath'] === 'string') this.checkpoints.snapshotBefore(resolveToolPath(args['filepath']));
        }

        result = await this.toolRegistry.dispatch(tc.function.name, args, allowed);

        if (reg.permission === 'write' || reg.permission === 'delete') {
          const filePath = (args['path'] ?? args['filepath']) as string | undefined;
          if (filePath) {
            const resolved = resolveToolPath(filePath);
            this.codeLens.markPending([resolved]);
            this.applyDiffDecorations(tc.function.name, resolved);
            this.postFileDiff(tc.function.name, resolved, convId);
          }
        }
      } catch (err) {
        this.failureTracker.record();
        result = `Error: ${(err as Error).message}`;
      }

      this.postResult(tc, result, args, convId);
      messages.push({ role: 'tool', content: result, tool_call_id: tc.id, name: tc.function.name });
    }
  }

  async openFile(filePath: string): Promise<void> {
    const uri = vscode.Uri.file(resolveToolPath(filePath));
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
  }

  private postFileDiff(toolName: string, resolvedPath: string, convId?: string): void {
    const FILE_DIFF_TOOLS = new Set(['write_file', 'replace_in_file', 'delete_file']);
    if (!FILE_DIFF_TOOLS.has(toolName)) return;

    const beforeContent = this.checkpoints.readSnapshotContent(resolvedPath);
    if (beforeContent === undefined) return;

    const isDeleted = !fs.existsSync(resolvedPath);
    const afterContent = isDeleted ? '' : fs.readFileSync(resolvedPath, 'utf8');
    const isNew = beforeContent === null;
    const hunks = !isDeleted ? computeDiff(beforeContent ?? '', afterContent) : null;
    const relPath = vscode.workspace.asRelativePath(resolvedPath, true);
    this.post({ type: 'fileDiff', filePath: relPath, hunks, isNew, isDeleted, ...(convId ? { conversationId: convId } : {}) });
  }

  private applyDiffDecorations(toolName: string, resolvedPath: string): void {
    const DIFF_TOOLS = new Set(['write_file', 'replace_in_file', 'delete_file']);
    if (!DIFF_TOOLS.has(toolName)) return;

    const beforeContent = this.checkpoints.readSnapshotContent(resolvedPath);
    if (beforeContent === undefined) return;

    this.diffDecorations.apply(resolvedPath, beforeContent);
  }

  private postResult(tc: ToolCall, result: string, args?: Record<string, unknown>, convId?: string): void {
    const fileLink = this.buildFileLink(tc.function.name, result, args);
    const suffix = fileLink ? ` (${fileLink})` : '';
    const cid = convId ? { conversationId: convId } : {};

    const READ_ONLY_TOOLS = new Set(['read_file', 'list_directory', 'search_code', 'get_diagnostics']);
    if (READ_ONLY_TOOLS.has(tc.function.name)) {
      const pathArg = typeof args?.['path'] === 'string' ? args['path']
        : typeof args?.['filepath'] === 'string' ? args['filepath'] : null;
      const label = pathArg ?? result.slice(0, 80).replace(/\r?\n/g, ' ');
      this.post({ type: 'token', text: `\n\n> **${tc.function.name}** → \`${label}\`${suffix}\n\n`, ...cid });
      return;
    }

    const truncated = result.length > 600 ? result.slice(0, 600) + '…' : result;
    const preview = truncated.replace(/\[(file|dir|staged)\]\s*/g, '').replace(/\r?\n/g, ' ');
    this.post({ type: 'token', text: `\n\n> **${tc.function.name}** → \`${preview}\`${suffix}\n\n`, ...cid });
    if (fileLink) {
      const rawPath = typeof args?.['path'] === 'string' ? args['path']
        : typeof args?.['filepath'] === 'string' ? args['filepath'] : null;
      if (rawPath) void this.openFile(rawPath);
    }
  }

  private buildFileLink(toolName: string, result: string, args?: Record<string, unknown>): string | null {
    if (result.startsWith('Error:') || result.startsWith('User declined:')) return null;
    if (!['write_file', 'replace_in_file', 'format_file'].includes(toolName)) return null;
    const rawPath = typeof args?.['path'] === 'string'
      ? args['path']
      : typeof args?.['filepath'] === 'string'
        ? args['filepath']
        : null;
    if (!rawPath) return null;
    const resolved = resolveToolPath(rawPath);
    const label = vscode.workspace.asRelativePath(resolved, false) || path.basename(resolved);
    return `[open ${label}](forge-file://${encodeURIComponent(resolved)})`;
  }
}
