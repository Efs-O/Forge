import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as vscode from 'vscode';
import type { HostToWebview } from './messageBridge';
import { computeDiff, parseUnifiedDiff } from './DiffUtils';
import type { DiffHunk } from './messageBridge';
import type { ChatMessage, ToolCall } from '../llm/types';
import type { CheckpointStack } from '../checkpoint/CheckpointStack';
import type { KeepUndoCodeLensProvider } from './KeepUndoCodeLens';
import type { ToolPermission } from '../tools/ToolRegistry';
import { ToolRegistry } from '../tools/ToolRegistry';
import { ToolFailureTracker } from '../tools/StripTools';
import type { DiffDecorations } from './DiffDecorations';

const WRITE_PERMISSIONS = new Set<ToolPermission>(['write', 'delete']);

/** Fall back to `git diff --no-index` for files that exceed the LCS line cap. */
function gitDiffLarge(before: string, after: string): DiffHunk[] | null {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const beforePath = path.join(os.tmpdir(), `forge-diff-a-${stamp}.tmp`);
  const afterPath = path.join(os.tmpdir(), `forge-diff-b-${stamp}.tmp`);
  try {
    fs.writeFileSync(beforePath, before, 'utf8');
    fs.writeFileSync(afterPath, after, 'utf8');
    const result = spawnSync(
      'git',
      ['diff', '--no-index', '--unified=3', '--', beforePath, afterPath],
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
    );
    // exit 0 = identical, 1 = files differ (both are success cases here)
    if (result.status !== 0 && result.status !== 1) return null;
    return parseUnifiedDiff(result.stdout ?? '');
  } catch {
    return null;
  } finally {
    try {
      fs.unlinkSync(beforePath);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(afterPath);
    } catch {
      /* ignore */
    }
  }
}

export function resolveToolPath(filePath: string): string {
  if (path.isAbsolute(filePath)) return path.normalize(filePath);
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? path.normalize(path.join(folder.uri.fsPath, filePath)) : path.normalize(filePath);
}

export class ToolDispatch {
  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly checkpoints: CheckpointStack,
    private readonly codeLens: KeepUndoCodeLensProvider,
    private readonly failureTracker: ToolFailureTracker,
    private readonly post: (msg: HostToWebview) => void,
    private readonly requestApproval: (
      toolName: string,
      detail: string,
      isDangerous?: boolean,
      convId?: string,
    ) => Promise<boolean>,
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
          messages.push({
            role: 'tool',
            content: result,
            tool_call_id: tc.id,
            name: tc.function.name,
          });
          continue;
        }

        const reg = this.toolRegistry.get(tc.function.name);
        if (!reg) {
          result = `Error: unknown tool "${tc.function.name}"`;
          this.postResult(tc, result, undefined, convId);
          messages.push({
            role: 'tool',
            content: result,
            tool_call_id: tc.id,
            name: tc.function.name,
          });
          continue;
        }

        const needsConfirm =
          WRITE_PERMISSIONS.has(reg.permission) ||
          reg.permission === 'terminal' ||
          reg.permission === 'headless' ||
          reg.permission === 'git-write';
        if (needsConfirm) {
          const raw = JSON.stringify(args, null, 2);
          const detail = raw.length > 300 ? raw.slice(0, 300) + '\n…' : raw;
          const isDangerous = tc.function.name === 'delete_file' && args['recursive'] === true;
          const approved = await this.requestApproval(
            tc.function.name,
            detail,
            isDangerous,
            convId,
          );
          if (!approved) {
            result = `User declined: ${tc.function.name}`;
            this.postResult(tc, result, undefined, convId);
            messages.push({
              role: 'tool',
              content: result,
              tool_call_id: tc.id,
              name: tc.function.name,
            });
            continue;
          }
        }

        const mutationPaths = reg.mutation?.paths(args).map(resolveToolPath) ?? [];
        this.snapshotPaths(mutationPaths);

        result = await this.toolRegistry.dispatch(tc.function.name, args, allowed, {
          beforeMutate: (paths) => this.snapshotPaths(paths.map(resolveToolPath)),
        });

        if (reg.mutation) {
          this.codeLens.markPending(mutationPaths);
          if (reg.mutation.showDiff) {
            for (const resolved of mutationPaths) {
              this.applyDiffDecorations(resolved);
              this.postFileDiff(resolved, convId);
            }
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

  private snapshotPaths(paths: string[]): void {
    for (const filePath of paths) this.checkpoints.snapshotBefore(filePath);
  }

  private postFileDiff(resolvedPath: string, convId?: string): void {
    const beforeContent = this.checkpoints.readSnapshotContent(resolvedPath);
    if (beforeContent === undefined) return;

    const isDeleted = !fs.existsSync(resolvedPath);
    const afterContent = isDeleted ? '' : fs.readFileSync(resolvedPath, 'utf8');
    const isNew = beforeContent === null;
    let hunks = !isDeleted ? computeDiff(beforeContent ?? '', afterContent) : null;
    if (hunks === null && !isDeleted) hunks = gitDiffLarge(beforeContent ?? '', afterContent);
    const relPath = vscode.workspace.asRelativePath(resolvedPath, true);
    this.post({
      type: 'fileDiff',
      filePath: relPath,
      hunks,
      isNew,
      isDeleted,
      ...(convId ? { conversationId: convId } : {}),
    });
  }

  private applyDiffDecorations(resolvedPath: string): void {
    const beforeContent = this.checkpoints.readSnapshotContent(resolvedPath);
    if (beforeContent === undefined) return;

    this.diffDecorations.apply(resolvedPath, beforeContent);
  }

  private postResult(
    tc: ToolCall,
    result: string,
    args?: Record<string, unknown>,
    convId?: string,
  ): void {
    const fileLink = this.buildFileLink(tc.function.name, result, args);
    const suffix = fileLink ? ` (${fileLink})` : '';
    const cid = convId ? { conversationId: convId } : {};

    const READ_ONLY_TOOLS = new Set([
      'read_file',
      'list_directory',
      'search_code',
      'get_diagnostics',
    ]);
    if (READ_ONLY_TOOLS.has(tc.function.name)) {
      const pathArg =
        typeof args?.['path'] === 'string'
          ? args['path']
          : typeof args?.['filepath'] === 'string'
            ? args['filepath']
            : null;
      const label = pathArg ?? result.slice(0, 80).replace(/\r?\n/g, ' ');
      this.post({
        type: 'token',
        text: `\n\n> **${tc.function.name}** → \`${label}\`${suffix}\n\n`,
        ...cid,
      });
      return;
    }

    const truncated = result.length > 600 ? result.slice(0, 600) + '…' : result;
    const preview = truncated.replace(/\[(file|dir|staged)\]\s*/g, '').replace(/\r?\n/g, ' ');
    this.post({
      type: 'token',
      text: `\n\n> **${tc.function.name}** → \`${preview}\`${suffix}\n\n`,
      ...cid,
    });
    if (fileLink) {
      const rawPath =
        typeof args?.['path'] === 'string'
          ? args['path']
          : typeof args?.['filepath'] === 'string'
            ? args['filepath']
            : null;
      if (rawPath) void this.openFile(rawPath);
    }
  }

  private buildFileLink(
    toolName: string,
    result: string,
    args?: Record<string, unknown>,
  ): string | null {
    if (result.startsWith('Error:') || result.startsWith('User declined:')) return null;
    if (!['write_file', 'replace_in_file', 'format_file'].includes(toolName)) return null;
    const rawPath =
      typeof args?.['path'] === 'string'
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
