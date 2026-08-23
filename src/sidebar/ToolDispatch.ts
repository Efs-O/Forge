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
import type { CheckpointSession } from '../checkpoint/CheckpointStack';
import type { KeepUndoCodeLensProvider } from './KeepUndoCodeLens';
import type { ToolPermission } from '../tools/ToolRegistry';
import { ToolRegistry } from '../tools/ToolRegistry';
import { ToolFailureTracker } from '../tools/StripTools';
import type { ToolBudget } from '../tools/ToolBudget';
import type { DiffDecorations } from './DiffDecorations';
import { resolveWorkspacePath, type ResolveWorkspacePathOptions } from '../util/WorkspacePaths';
import { capDisplayText } from '../tools/resultCap';
import { isFailureResult, readPathArg, resultLabel } from './toolResultView';

const WRITE_PERMISSIONS = new Set<ToolPermission>(['write', 'delete']);
const DELETE_PREVIEW_LIMIT = 8;
const DELETE_SCAN_LIMIT = 2_000;

interface DeleteInventory {
  files: number;
  directories: number;
  bytes: number;
  preview: string[];
  truncated: boolean;
}

export interface RecordedFileDiff {
  toolCallId: string;
  filePath: string;
  hunks: DiffHunk[] | null;
  isNew: boolean;
  isDeleted: boolean;
}

/**
 * Build an approval message from the filesystem state before a destructive
 * action. The scan is deliberately bounded: confirmation must stay responsive
 * even when a model targets a very large generated directory.
 */
function describeDelete(args: Record<string, unknown>): string {
  const requestedPath = typeof args['path'] === 'string' ? args['path'] : '(invalid path)';
  const recursive = args['recursive'] === true;
  const lines = ['About to permanently delete:', `Target: ${requestedPath}`];

  try {
    const target = resolveToolPath(requestedPath);
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      const kind = stat.isSymbolicLink() ? 'symbolic link' : 'file';
      lines.push(`Type: ${kind} (${stat.size.toLocaleString()} bytes)`);
      lines.push('Scope: this item only.');
    } else {
      const inventory = inspectDeleteDirectory(target);
      lines.push('Type: directory');
      lines.push(
        recursive
          ? 'Scope: recursive — this directory and every nested item will be deleted.'
          : 'Scope: this directory only — deletion will fail if it is not empty.',
      );
      lines.push(
        `Current contents: ${inventory.files.toLocaleString()} files, ` +
          `${inventory.directories.toLocaleString()} folders, ` +
          `${inventory.bytes.toLocaleString()} bytes${inventory.truncated ? ' (scan capped)' : ''}.`,
      );
      if (inventory.preview.length > 0) {
        lines.push(
          `First items: ${inventory.preview.join(', ')}${inventory.truncated ? ', …' : ''}`,
        );
      }
    }
  } catch (err) {
    lines.push('Status: Forge could not inspect this target before deletion.');
    lines.push(`Inspection error: ${(err as Error).message}`);
    lines.push(
      recursive
        ? 'Scope requested: recursive — all contents would be deleted if the target is accessible.'
        : 'Scope requested: this item only.',
    );
  }

  lines.push("Forge will create this turn's Undo checkpoint immediately before deletion.");
  return lines.join('\n');
}

function inspectDeleteDirectory(root: string): DeleteInventory {
  const inventory: DeleteInventory = {
    files: 0,
    directories: 0,
    bytes: 0,
    preview: [],
    truncated: false,
  };
  const pending: Array<{ absolute: string; relative: string }> = [{ absolute: root, relative: '' }];
  let inspected = 0;

  while (pending.length > 0 && !inventory.truncated) {
    const current = pending.pop();
    if (!current) break;
    for (const entry of fs.readdirSync(current.absolute, { withFileTypes: true })) {
      inspected++;
      const relative = current.relative ? path.join(current.relative, entry.name) : entry.name;
      if (inventory.preview.length < DELETE_PREVIEW_LIMIT) {
        inventory.preview.push(entry.isDirectory() ? `${relative}${path.sep}` : relative);
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        inventory.directories++;
        pending.push({ absolute: path.join(current.absolute, entry.name), relative });
      } else {
        inventory.files++;
        try {
          inventory.bytes += fs.lstatSync(path.join(current.absolute, entry.name)).size;
        } catch {
          // The delete itself will report an inaccessible entry. Keep the
          // confirmation useful for everything that was inspectable.
        }
      }
      if (inspected >= DELETE_SCAN_LIMIT) {
        inventory.truncated = true;
        break;
      }
    }
  }
  return inventory;
}

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

export type ResolveToolPathOptions = ResolveWorkspacePathOptions;
export const resolveToolPath = resolveWorkspacePath;

/** How a transcript file reference should be revealed in the editor. */
export interface OpenFileOptions {
  /** 1-based line from a `path:42` reference. */
  line?: number | undefined;
  beside?: boolean | undefined;
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
      signal?: AbortSignal,
    ) => Promise<boolean>,
    private readonly diffDecorations: DiffDecorations,
  ) {}

  async dispatch(
    toolCalls: ToolCall[],
    allowed: Set<ToolPermission>,
    messages: ChatMessage[],
    convId?: string,
    signal?: AbortSignal,
    checkpoint?: CheckpointSession,
    budget?: ToolBudget,
    recordFileDiff?: (diff: RecordedFileDiff) => void,
  ): Promise<void> {
    for (const tc of toolCalls) {
      let result: string;
      let args: Record<string, unknown> | undefined;
      try {
        if (signal?.aborted) {
          result = 'Error: tool execution cancelled';
          this.postResult(tc, result, undefined, convId);
          messages.push({
            role: 'tool',
            content: result,
            tool_call_id: tc.id,
            name: tc.function.name,
          });
          continue;
        }
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
        const budgetBlock = budget?.check(tc.function.name);
        if (budgetBlock) {
          this.postResult(tc, budgetBlock, undefined, convId);
          messages.push({
            role: 'tool',
            content: budgetBlock,
            tool_call_id: tc.id,
            name: tc.function.name,
          });
          continue;
        }

        const requiredPermissions = this.toolRegistry.requiredPermissions(reg, args);
        const approvalMetadata = reg.approval?.(args);
        const needsConfirm =
          approvalMetadata !== undefined ||
          (!reg.autoApprove &&
            requiredPermissions.some(
              (permission) =>
                WRITE_PERMISSIONS.has(permission) ||
                permission === 'terminal' ||
                permission === 'headless' ||
                permission === 'git-write',
            ));
        if (needsConfirm) {
          const raw = JSON.stringify(args, null, 2);
          const fallbackDetail = raw.length > 300 ? raw.slice(0, 300) + '\n…' : raw;
          const detail =
            approvalMetadata?.detail ??
            (tc.function.name === 'delete_file' ? describeDelete(args) : fallbackDetail);
          const isDangerous =
            approvalMetadata?.dangerous ??
            (tc.function.name === 'delete_file' && args['recursive'] === true);
          const approved = signal
            ? await this.requestApproval(tc.function.name, detail, isDangerous, convId, signal)
            : await this.requestApproval(tc.function.name, detail, isDangerous, convId);
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

        const rawMutationPaths = reg.mutation?.paths(args) ?? [];
        const mutationPaths = rawMutationPaths.map((p) => resolveToolPath(p));
        this.snapshotPaths(mutationPaths, checkpoint);

        result = await this.toolRegistry.dispatch(tc.function.name, args, allowed, {
          beforeMutate: (paths) => {
            const resolved = paths.map((p) => resolveToolPath(p));
            this.snapshotPaths(resolved, checkpoint);
          },
          ...(signal !== undefined ? { abortSignal: signal } : {}),
          ...(convId !== undefined ? { conversationId: convId } : {}),
        });

        if (reg.mutation) {
          this.codeLens.markPending(mutationPaths);
          if (reg.mutation.showDiff) {
            for (const resolved of mutationPaths) {
              this.applyDiffDecorations(resolved, checkpoint);
              this.postFileDiff(resolved, convId, checkpoint, tc.id, recordFileDiff);
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

  async openFile(filePath: string, options?: OpenFileOptions): Promise<void> {
    const uri = vscode.Uri.file(resolveToolPath(filePath));
    const doc = await vscode.workspace.openTextDocument(uri);
    // `line` arrives 1-based from the transcript; VS Code positions are 0-based.
    const zeroBased = options?.line === undefined ? undefined : Math.max(0, options.line - 1);
    const target =
      zeroBased === undefined ? undefined : new vscode.Range(zeroBased, 0, zeroBased, 0);
    await vscode.window.showTextDocument(doc, {
      preview: false,
      preserveFocus: false,
      ...(options?.beside ? { viewColumn: vscode.ViewColumn.Beside } : {}),
      ...(target ? { selection: target } : {}),
    });
  }

  private snapshotPaths(paths: string[], checkpoint?: CheckpointSession): void {
    for (const filePath of paths) {
      if (checkpoint) checkpoint.snapshotBefore(filePath);
      else this.checkpoints.snapshotBefore(filePath);
    }
  }

  private postFileDiff(
    resolvedPath: string,
    convId?: string,
    checkpoint?: CheckpointSession,
    toolCallId?: string,
    recordFileDiff?: (diff: RecordedFileDiff) => void,
  ): void {
    const beforeContent = checkpoint
      ? checkpoint.readSnapshotContent(resolvedPath)
      : this.checkpoints.readSnapshotContent(resolvedPath);
    if (beforeContent === undefined) return;

    const isDeleted = !fs.existsSync(resolvedPath);
    const afterContent = isDeleted ? '' : fs.readFileSync(resolvedPath, 'utf8');
    const isNew = beforeContent === null;
    let hunks = !isDeleted ? computeDiff(beforeContent ?? '', afterContent) : null;
    if (hunks === null && !isDeleted) hunks = gitDiffLarge(beforeContent ?? '', afterContent);
    const relPath = vscode.workspace.asRelativePath(resolvedPath);
    if (toolCallId) {
      recordFileDiff?.({ toolCallId, filePath: relPath, hunks, isNew, isDeleted });
    }
    this.post({
      type: 'fileDiff',
      filePath: relPath,
      hunks,
      isNew,
      isDeleted,
      ...(convId ? { conversationId: convId } : {}),
    });
  }

  private applyDiffDecorations(resolvedPath: string, checkpoint?: CheckpointSession): void {
    const beforeContent = checkpoint
      ? checkpoint.readSnapshotContent(resolvedPath)
      : this.checkpoints.readSnapshotContent(resolvedPath);
    if (beforeContent === undefined) return;

    this.diffDecorations.apply(resolvedPath, beforeContent);
  }

  private postResult(
    tc: ToolCall,
    result: string,
    args?: Record<string, unknown>,
    convId?: string,
  ): void {
    const toolName = tc.function.name;
    const pathArg = readPathArg(args);
    const touchedFile = this.touchedFilePath(toolName, result, args);
    const { text, totalChars } = capDisplayText(result);
    const isError = isFailureResult(result);

    this.post({
      type: 'toolResult',
      toolName,
      toolCallId: tc.id,
      label: resultLabel(toolName, result, pathArg),
      text,
      totalChars,
      ...(touchedFile ? { filePath: touchedFile } : {}),
      ...(isError ? { isError: true } : {}),
      ...(convId ? { conversationId: convId } : {}),
    });

    if (!touchedFile || !pathArg) return;
    const autoOpenChangedFiles = vscode.workspace
      .getConfiguration('forge.editor')
      .get<boolean>('autoOpenChangedFiles', false);
    if (autoOpenChangedFiles) void this.openFile(pathArg);
  }

  /** Absolute path a write-style tool just changed, for the row's open link. */
  private touchedFilePath(
    toolName: string,
    result: string,
    args?: Record<string, unknown>,
  ): string | null {
    if (isFailureResult(result)) return null;
    if (!['write_file', 'append_file', 'edit_file', 'format_file'].includes(toolName)) return null;
    const rawPath = readPathArg(args);
    return rawPath ? resolveToolPath(rawPath) : null;
  }
}
