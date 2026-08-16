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
import type { WorkerRunContext, WorkerRunRequest, WorkerRunResult } from '../workers/types';
import { resolveWorkspacePath, type ResolveWorkspacePathOptions } from '../util/WorkspacePaths';
import { capDisplayText } from '../tools/resultCap';
import { isFailureResult, readPathArg, resultLabel } from './toolResultView';

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

export type ResolveToolPathOptions = ResolveWorkspacePathOptions;
export const resolveToolPath = resolveWorkspacePath;

/** How a transcript file reference should be revealed in the editor. */
export interface OpenFileOptions {
  /** 1-based line from a `path:42` reference. */
  line?: number | undefined;
  beside?: boolean | undefined;
}

export class ToolDispatch {
  private workerRunner?: (
    request: WorkerRunRequest,
    context: WorkerRunContext,
  ) => Promise<WorkerRunResult>;

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

  setWorkerRunner(
    runner: (request: WorkerRunRequest, context: WorkerRunContext) => Promise<WorkerRunResult>,
  ): void {
    this.workerRunner = runner;
  }

  async dispatch(
    toolCalls: ToolCall[],
    allowed: Set<ToolPermission>,
    messages: ChatMessage[],
    convId?: string,
    signal?: AbortSignal,
    scope?: import('../tools/ToolRegistry').ToolScope,
    checkpoint?: CheckpointSession,
    coordinatorModel?: string,
    budget?: ToolBudget,
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
        if (scope && !scope.allowedNames.has(tc.function.name)) {
          throw new Error(`Tool "${tc.function.name}" is outside the active worker scope`);
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
        scope?.validate?.(reg, args);

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
          const detail = approvalMetadata?.detail ?? fallbackDetail;
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
        scope?.validateMutationPaths?.(rawMutationPaths);
        const mutationPaths = rawMutationPaths.map((p) => resolveToolPath(p));
        this.snapshotPaths(mutationPaths, checkpoint);

        result = await this.toolRegistry.dispatch(
          tc.function.name,
          args,
          allowed,
          {
            beforeMutate: (paths) => {
              scope?.validateMutationPaths?.(paths);
              const resolved = paths.map((p) => resolveToolPath(p));
              this.snapshotPaths(resolved, checkpoint);
            },
            ...(signal !== undefined ? { abortSignal: signal } : {}),
            ...(convId !== undefined ? { conversationId: convId } : {}),
            ...(this.workerRunner && checkpoint && convId && signal
              ? {
                  runWorkers: (request: WorkerRunRequest) =>
                    this.workerRunner?.(request, {
                      checkpoint,
                      conversationId: convId,
                      abortSignal: signal,
                      toolDispatch: this,
                      ...(coordinatorModel ? { coordinatorModel } : {}),
                    }) ?? Promise.reject(new Error('Worker runner unavailable')),
                }
              : {}),
          },
          scope,
          true,
        );
        scope?.onResult?.(reg, args, result);

        if (reg.mutation) {
          this.codeLens.markPending(mutationPaths);
          if (reg.mutation.showDiff) {
            for (const resolved of mutationPaths) {
              this.applyDiffDecorations(resolved, checkpoint);
              this.postFileDiff(resolved, convId, checkpoint);
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
      label: resultLabel(toolName, result, pathArg),
      text,
      totalChars,
      ...(touchedFile ? { filePath: touchedFile } : {}),
      ...(isError ? { isError: true } : {}),
      ...(convId ? { conversationId: convId } : {}),
    });

    if (touchedFile && pathArg) void this.openFile(pathArg);
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
