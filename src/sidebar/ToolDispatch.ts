import * as fs from 'fs';
import * as vscode from 'vscode';
import type { HostToWebview } from './messageBridge';
import { diffContents } from './DiffUtils';
import { isExistingDirectory, readCallDiffBase } from './callDiffBase';
import type { ChatMessage, ToolCall } from '../llm/types';
import type { CheckpointStack } from '../checkpoint/CheckpointStack';
import type { CheckpointSession } from '../checkpoint/CheckpointStack';
import type { KeepUndoCodeLensProvider } from './KeepUndoCodeLens';
import type { ToolHandlerResult, ToolPermission } from '../tools/ToolRegistry';
import { ToolRegistry } from '../tools/ToolRegistry';
import { repairTrailingPathSpace, trailingPathSpaceNote } from '../tools/pathArgTrim';
import { ToolFailureTracker } from '../tools/StripTools';
import type { ToolBudget } from '../tools/ToolBudget';
import type { DiffDecorations } from './DiffDecorations';
import { resolveWorkspacePath } from '../util/WorkspacePaths';
import { capDisplayText } from '../tools/resultCap';
import { describeDelete } from './deletePreview';
import { rememberQuestionRecord } from './sessionQuestionRecords';
import { isFailureResult, readPathArg, resultLabel, touchedFilePath } from './toolResultView';
import type { PlanItem } from './sessionTypes';
import type { QuestionAnswerRecord } from '../util/questionAnswers';
import type { ChatRuleApproval } from './chatApprovalRules';
import { getLogger } from '../util/logger';
import {
  ToolApprovalPolicyDenied,
  toolApprovalResult,
  type ToolApprovalCallOptions,
  type ToolApprovalOutcome,
} from './toolApprovalOutcome';
import { unknownToolResult } from './retiredTools';
import { toolErrorText } from '../tools/toolErrorText';
import { approvalCallOptions } from './approvalCallOptions';
import { markConversationReadUntrusted } from '../tools/exfilTaint';
import {
  dispatchWithParallelReads,
  type BufferedToolDispatchEffects,
  type ToolDispatchEffects,
} from './ToolDispatchParallel';
import {
  evaluateToolApproval,
  readToolApprovalMetadata,
  type CachedToolApproval,
} from './toolApprovalEvaluation';
import {
  toolResultContent,
  toolResultMessage,
  toolResultQuestionRecord,
  toolResultText,
  type RecordedFileDiff,
  type ToolDispatchModelContext,
  type ToolDispatchRoundContext,
} from './toolDispatchTypes';

const log = getLogger();
export const resolveToolPath = resolveWorkspacePath;

/** How a transcript file reference should be revealed in the editor. */
export interface OpenFileOptions {
  /** 1-based line from a `path:42` reference. */
  line?: number | undefined;
  beside?: boolean | undefined;
}

interface InternalToolDispatchOptions {
  skipParallel: boolean;
  cachedApproval?: CachedToolApproval | undefined;
  effects?: ToolDispatchEffects;
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
      options?: ToolApprovalCallOptions,
    ) => Promise<ToolApprovalOutcome>,
    private readonly diffDecorations: DiffDecorations,
    /** A chat rule that already covers this call answers it before the card opens,
     *  and says which key covered it. Absent: chat rules are never consulted. */
    private readonly chatRuleApproval?: ChatRuleApproval,
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
    unavailableTools?: ReadonlyMap<string, string>,
    setPlan?: (items: PlanItem[]) => void,
    tellArrived?: (callback: () => void) => () => void,
    modelContext?: ToolDispatchModelContext,
    internal?: InternalToolDispatchOptions,
  ): Promise<void> {
    const effects = internal?.effects ?? {
      messages,
      post: this.post,
      failureTracker: this.failureTracker,
    };
    const context: ToolDispatchRoundContext = {
      allowed,
      convId,
      signal,
      checkpoint,
      budget,
      recordFileDiff,
      unavailableTools,
      setPlan,
      tellArrived,
      modelContext,
    };
    const dispatchOne = (
      call: ToolCall,
      approval?: CachedToolApproval,
      bufferedEffects?: BufferedToolDispatchEffects,
    ): Promise<void> =>
      this.dispatch(
        [call],
        allowed,
        bufferedEffects?.messages ?? messages,
        convId,
        signal,
        checkpoint,
        budget,
        recordFileDiff,
        unavailableTools,
        setPlan,
        tellArrived,
        modelContext,
        {
          skipParallel: true,
          cachedApproval: approval,
          ...(bufferedEffects ? { effects: bufferedEffects } : {}),
        },
      );
    if (!internal?.skipParallel) {
      await dispatchWithParallelReads(
        toolCalls,
        context,
        this.toolRegistry,
        messages,
        effects.failureTracker,
        effects.post,
        dispatchOne,
        dispatchOne,
      );
      return;
    }

    for (const tc of toolCalls) {
      // The span is stamped once here and read by `toolResultMessage` on whichever branch
      // wins. The early refusals (declined, unknown tool, budget) are timed too:
      // they are near-instant and fall under the display floor, so they simply
      // render without a duration rather than needing a special case.
      const startedAt = Date.now();
      let result: ToolHandlerResult;
      let args: Record<string, unknown> | undefined;
      try {
        if (signal?.aborted) {
          result = 'Error: tool execution cancelled';
          this.postResult(tc, toolResultText(result), undefined, convId, effects.post);
          messages.push(toolResultMessage(tc, toolResultContent(result), startedAt));
          continue;
        }
        try {
          const parsed: unknown = JSON.parse(tc.function.arguments);
          if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
            const got = parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed;
            result = `Error: ${tc.function.name}: arguments must be a JSON object, got ${got}.`;
            effects.failureTracker.record(convId);
            this.postResult(tc, toolResultText(result), undefined, convId, effects.post);
            messages.push(toolResultMessage(tc, toolResultContent(result), startedAt));
            continue;
          }
          args = parsed as Record<string, unknown>;
        } catch (error) {
          const parserMessage = error instanceof Error ? error.message : String(error);
          effects.failureTracker.record(convId);
          result =
            `Error: ${tc.function.name}: the arguments are not valid JSON (${parserMessage}). ` +
            'Write each literal backslash as \\ and resend.';
          this.postResult(tc, toolResultText(result), undefined, convId, effects.post);
          messages.push(toolResultMessage(tc, toolResultContent(result), startedAt));
          continue;
        }

        if (tc.function.name === '__tool_call_error__' && typeof args['__error'] === 'string') {
          // The parser's own refusal is a failure by definition, and every consumer
          // that reads a result's text keys on the `Error:` prefix, so the marker is
          // added when the model sent the text without it.
          const reported = args['__error'];
          result = reported.startsWith('Error:') ? reported : `Error: ${reported}`;
          effects.failureTracker.record(convId);
          this.postResult(tc, toolResultText(result), undefined, convId, effects.post);
          messages.push(toolResultMessage(tc, toolResultContent(result), startedAt));
          continue;
        }

        // Registered but withheld from this model (e.g. view_image without a
        // projector). The tool would still execute if called blind — say why
        // instead, so the model does not go hunting for a substitute.
        const unavailable = unavailableTools?.get(tc.function.name);
        if (unavailable) {
          this.postResult(tc, unavailable, undefined, convId, effects.post);
          messages.push(toolResultMessage(tc, unavailable, startedAt));
          continue;
        }

        const reg = this.toolRegistry.get(tc.function.name);
        if (!reg) {
          result = unknownToolResult(
            tc.function.name,
            this.toolRegistry,
            allowed,
            budget,
            convId,
            unavailableTools,
          );
          this.postResult(tc, toolResultText(result), undefined, convId, effects.post);
          messages.push(toolResultMessage(tc, toolResultContent(result), startedAt));
          continue;
        }
        const invalid = this.toolRegistry.invalidArgs(reg, args);
        if (invalid) {
          effects.failureTracker.record(convId);
          this.postResult(tc, invalid, undefined, convId, effects.post);
          messages.push(toolResultMessage(tc, invalid, startedAt));
          continue;
        }
        const budgetBlock = budget?.check(tc.function.name);
        if (budgetBlock) {
          this.postResult(tc, budgetBlock, undefined, convId, effects.post);
          messages.push(toolResultMessage(tc, budgetBlock, startedAt));
          continue;
        }

        // A path argument ending in whitespace is a stray space, not a filename
        // (pathArgTrim.ts). Repair it here, before the approval metadata, `mutation.paths`
        // and the checkpoint snapshot read `args`, so every gate and the handler judge the
        // one path the tool will write. The repair is reported with the call's result.
        const repairedPathArgs = repairTrailingPathSpace(
          (reg.describe ? reg.describe() : reg.definition).function.parameters,
          args,
        );

        const approvalCache =
          internal?.cachedApproval ?? (await readToolApprovalMetadata(reg, args, convId));
        const {
          approvalMetadata,
          isDangerous,
          mutationPaths,
          outsideMutationPaths,
          exitInput,
          exitVerdict,
        } = evaluateToolApproval(tc, reg, args, context, approvalCache, this.toolRegistry);
        // A chat rule that covers every key this call needs answers the card before
        // it opens and writes the `gate` row saying who answered it;
        // `createChatRuleApproval` itself refuses to consult rules for an unattended
        // run, so a job or an unattended bus turn behaves exactly as it does today.
        // What it answers with when NOTHING covered the call is the other half: the
        // keys the owner could have allowed and what they say in plain words, which
        // is what makes the card that opens offer "Allow for this chat" — or not, for
        // a call whose key the rules refused, like `git rebase`.
        const chatRule =
          exitVerdict.card && convId !== undefined
            ? this.chatRuleApproval?.decide({
                ...exitInput,
                args,
                approvalMetadata,
                exitVerdict,
                mutationPaths,
                outsideMutationPaths,
                conversationId: convId,
                conversation: modelContext?.conversation,
              })
            : undefined;
        if (exitVerdict.card && chatRule?.kind !== 'answered') {
          const raw = JSON.stringify(args, null, 2);
          const fallbackDetail = raw.length > 300 ? raw.slice(0, 300) + '\n…' : raw;
          const detail =
            approvalMetadata?.detail ??
            (tc.function.name === 'delete_file' ? await describeDelete(args) : fallbackDetail);
          const outcome = await this.requestApproval(
            tc.function.name,
            detail,
            isDangerous,
            convId,
            signal,
            approvalCallOptions(approvalMetadata, exitVerdict, chatRule),
          );
          if (outcome !== 'approved') {
            result = toolApprovalResult(tc.function.name, outcome);
            this.postResult(tc, toolResultText(result), undefined, convId, effects.post);
            messages.push(toolResultMessage(tc, toolResultContent(result), startedAt));
            continue;
          }
        }

        this.snapshotPaths(mutationPaths, checkpoint);
        const callBase = reg.mutation?.showDiff ? readCallDiffBase(mutationPaths) : undefined;

        result = await this.toolRegistry.dispatch(tc.function.name, args, allowed, {
          beforeMutate: (paths) => {
            const resolved = paths.map((p) => resolveToolPath(p));
            this.snapshotPaths(resolved, checkpoint);
          },
          ...(signal !== undefined ? { abortSignal: signal } : {}),
          ...(convId !== undefined ? { conversationId: convId } : {}),
          toolCallId: tc.id,
          ...(modelContext ?? {}),
          conversationMessages: messages,
          ...(setPlan !== undefined ? { setPlan } : {}),
          ...(tellArrived !== undefined ? { tellArrived } : {}),
        });

        // The repair is reported here, where the call's own result is in hand: a trim the
        // model cannot see is a lie by omission, and on POSIX a trailing space is legal.
        const pathNote = trailingPathSpaceNote(repairedPathArgs);
        if (pathNote && typeof result === 'string') result = `${result}\n${pathNote}`;

        if (reg.mutation) {
          this.codeLens.markPending(mutationPaths);
          if (reg.mutation.showDiff) {
            // Rendering a diff happens AFTER the mutation succeeded, so a
            // failure here is a display problem, not a tool failure. Letting it
            // escape reported a completed `move_file` as EISDIR and charged the
            // failure tracker for it — the model then spent three rounds
            // "recovering" a move that had already happened.
            for (const resolved of mutationPaths) {
              try {
                this.applyDiffDecorations(resolved, checkpoint);
                this.postFileDiff(resolved, callBase, convId, checkpoint, tc.id, recordFileDiff);
              } catch (err) {
                log.error(`[ToolDispatch] diff render failed for ${resolved}: ${String(err)}`);
              }
            }
          }
        }

        // A call that ran clears this conversation's streak. The tracker counts
        // CONSECUTIVE failures: without this a model that recovered after nine
        // bad calls was still one call from losing its tools for the rest of
        // the chat. Refusals and declines are not successes and do not reset.
        if (!isFailureResult(toolResultText(result))) effects.failureTracker.reset(convId);
        /* The flag this chat now carries: `untrustedResult` means the tool brought
         * content in from outside, and a model can be told what to do by the text it
         * is reading. Marked after the handler ran, and only for a result that is not
         * a failure: a declined call produced no content to flag with.
         */
        if (
          reg.untrustedResult === true &&
          convId !== undefined &&
          !isFailureResult(toolResultText(result))
        ) {
          markConversationReadUntrusted(convId);
          // The stamp the conversation's record carries, written in the same round as
          // the row that brought the content in, so the next save keeps both.
          if (modelContext?.conversation) modelContext.conversation.untrusted_since_ms = Date.now();
        }
      } catch (err) {
        const policyDenied = err instanceof ToolApprovalPolicyDenied;
        if (!policyDenied) effects.failureTracker.record(convId);
        // A schema refusal is formatted, not printed: Zod's own message is a JSON
        // array of issues, which the model reads as data and re-sends unchanged.
        // `toolErrorText.ts` owns the one place every thrown tool error becomes a
        // result string, so no tool has to word its own refusals.
        result = policyDenied ? err.message : toolErrorText(tc.function.name, err, args);
      }

      const questionRecord = toolResultQuestionRecord(result);
      if (questionRecord && modelContext?.conversation) {
        rememberQuestionRecord(modelContext.conversation, tc.id, questionRecord);
      }
      this.postResult(tc, toolResultText(result), args, convId, effects.post, questionRecord);
      messages.push(toolResultMessage(tc, toolResultContent(result), startedAt));
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

  /** The card shows this call's change: against `callBase`, not the turn checkpoint (see callDiffBase.ts). */
  private postFileDiff(
    resolvedPath: string,
    callBase: Map<string, string | null> | undefined,
    convId?: string,
    checkpoint?: CheckpointSession,
    toolCallId?: string,
    recordFileDiff?: (diff: RecordedFileDiff) => void,
  ): void {
    const beforeContent = checkpoint
      ? checkpoint.readSnapshotContent(resolvedPath)
      : this.checkpoints.readSnapshotContent(resolvedPath);
    if (beforeContent === undefined) return;
    if (isExistingDirectory(resolvedPath)) return;
    const base = callBase?.has(resolvedPath) ? (callBase.get(resolvedPath) ?? null) : beforeContent;

    const isDeleted = !fs.existsSync(resolvedPath);
    const afterContent = isDeleted ? '' : fs.readFileSync(resolvedPath, 'utf8');
    const isNew = base === null;
    const hunks = isDeleted ? null : diffContents(base ?? '', afterContent);
    const relPath = vscode.workspace.asRelativePath(resolvedPath);
    if (toolCallId) {
      recordFileDiff?.({ toolCallId, filePath: relPath, hunks, isNew, isDeleted });
    }
    this.post({
      type: 'fileDiff',
      ...(toolCallId ? { toolCallId } : {}),
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
    if (isExistingDirectory(resolvedPath)) return;

    this.diffDecorations.apply(resolvedPath, beforeContent);
  }

  private postResult(
    tc: ToolCall,
    result: string,
    args?: Record<string, unknown>,
    convId?: string,
    post: (msg: HostToWebview) => void = this.post,
    questionRecord?: QuestionAnswerRecord,
  ): void {
    const toolName = tc.function.name;
    const pathArg = readPathArg(args);
    const touchedFile = touchedFilePath(toolName, result, args, resolveToolPath);
    const { text, totalChars } = capDisplayText(result);
    const isError = isFailureResult(result);

    post({
      type: 'toolResult',
      toolName,
      toolCallId: tc.id,
      label: resultLabel(toolName, result, pathArg),
      text,
      totalChars,
      ...(questionRecord ? { questionRecord } : {}),
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
}
