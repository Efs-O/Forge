import * as vscode from 'vscode';
import type { HostToWebview } from './messageBridge';
import { isExistingDirectory, readCallDiffBase } from './callDiffBase';
import { postFileDiff } from './postFileDiff';
import type { ChatMessage, ToolCall } from '../llm/types';
import type { CheckpointStack } from '../checkpoint/CheckpointStack';
import type { CheckpointSession } from '../checkpoint/CheckpointStack';
import type { KeepUndoCodeLensProvider } from './KeepUndoCodeLens';
import type { RegisteredTool, ToolHandlerResult, ToolPermission } from '../tools/ToolRegistry';
import { ToolApprovalRefusal } from '../tools/toolContract';
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
import type { ChatRuleApproval } from './chatRuleApproval';
import { getLogger } from '../util/logger';
import {
  approvalGrantNote,
  ToolApprovalPolicyDenied,
  toolApprovalResult,
  type ApprovalGrantRecord,
  type ToolApprovalCallOptions,
  type ToolApprovalOutcome,
} from './toolApprovalOutcome';
import { toolErrorText } from '../tools/toolErrorText';
import { approvalCallOptions } from './approvalCallOptions';
import { markConversationReadUntrusted } from '../tools/exfilTaint';
import { noteToolCall } from '../agent/fileChangeReminder';
import { unattendedConversations } from './unattendedConversations';
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
import { preflightToolCall } from './toolCallPreflight';

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
      // wins. The early refusals (declined, unknown tool, budget) are timed too: they are
      // near-instant and fall under the display floor, so they render without a duration.
      const startedAt = Date.now();
      let result: ToolHandlerResult;
      let args: Record<string, unknown> | undefined;
      try {
        const clankerMode =
          convId !== undefined &&
          !unattendedConversations.has(convId) &&
          this.chatRuleApproval?.isClankerEnabled?.(convId) === true;
        const pre = preflightToolCall(tc, {
          toolRegistry: this.toolRegistry,
          allowed,
          convId,
          signal,
          budget,
          unavailableTools,
          clankerMode,
        });
        if (pre.kind === 'refused') {
          // A protocolFailure counts toward the streak that switches this chat to text tools.
          if (pre.protocolFailure) effects.failureTracker.recordNativeParseFailure(convId);
          this.postResult(tc, toolResultText(pre.result), undefined, convId, effects.post);
          messages.push(toolResultMessage(tc, toolResultContent(pre.result), startedAt));
          continue;
        }
        args = pre.args;
        const handlerArgs = pre.args;
        const reg = pre.reg;
        // The queue writes the owner's answer time into this box; the call's own
        // result then says a human was asked and what the wait cost (BUG-14).
        const grant: ApprovalGrantRecord = {};

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
        const evaluation = evaluateToolApproval(
          tc,
          reg,
          args,
          context,
          approvalCache,
          this.toolRegistry,
        );
        const { mutationPaths } = evaluation;
        const outcome = await this.requestToolApproval(tc, args, evaluation, context, grant);
        if (outcome !== 'approved') {
          result = toolApprovalResult(tc.function.name, outcome);
          this.postResult(tc, toolResultText(result), undefined, convId, effects.post);
          messages.push(toolResultMessage(tc, toolResultContent(result), startedAt));
          continue;
        }

        this.snapshotPaths(mutationPaths, checkpoint);
        const callBase = reg.mutation?.showDiff ? readCallDiffBase(mutationPaths) : undefined;
        // Paths a tool reports at run time, on top of the `mutation.paths` the
        // evaluation already resolved. The file-change reminder needs both.
        const reportedMutationPaths: string[] = [];

        result = await this.toolRegistry.dispatch(tc.function.name, args, allowed, {
          beforeMutate: (paths) => {
            const resolved = paths.map((p) => resolveToolPath(p));
            reportedMutationPaths.push(...resolved);
            this.snapshotPaths(resolved, checkpoint);
          },
          ...(signal !== undefined ? { abortSignal: signal } : {}),
          ...(convId !== undefined ? { conversationId: convId } : {}),
          ...(convId !== undefined ? { clankerMode } : {}),
          ...(tc.function.name === 'web_fetch'
            ? {
                authorizeFetchRedirect: (url: string) =>
                  this.requestFetchRedirectApproval(url, tc, handlerArgs, reg, context, grant),
              }
            : {}),
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
        // A card the owner answered: say so, and how long it cost, next to the
        // result it unlocked. Without this the model has seen a 5-minute card and
        // reports "auto-approved, no card" to whoever asks what the run cost.
        const grantNote = approvalGrantNote(grant.waitedMs);
        if (grantNote && typeof result === 'string') result = `${result}\n${grantNote}`;

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
                postFileDiff(
                  this.post,
                  checkpoint ?? this.checkpoints,
                  resolved,
                  callBase,
                  convId,
                  tc.id,
                  recordFileDiff,
                );
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
        // What this call did to the files this chat has read, for the "changed on
        // disk since you read it" reminder (`fileChangeReminder.ts`). Only a call
        // that ran is reported: a declined or refused call wrote nothing, and a
        // reminder that is wrong is worse than none.
        if (convId !== undefined)
          noteToolCall(convId, {
            toolName: tc.function.name,
            permission: reg.permission,
            hasMutation: reg.mutation !== undefined,
            args: handlerArgs,
            resultFailed: isFailureResult(toolResultText(result)),
            touchedPaths: [...mutationPaths, ...reportedMutationPaths],
          });
      } catch (err) {
        const policyDenied = err instanceof ToolApprovalPolicyDenied;
        const approvalRefused = err instanceof ToolApprovalRefusal;
        // Nothing is recorded here: a failed call is not a protocol failure.
        // A schema refusal is formatted, not printed: Zod's own message is a JSON
        // array of issues, which the model reads as data and re-sends unchanged.
        // `toolErrorText.ts` owns the one place every thrown tool error becomes a
        // result string, so no tool has to word its own refusals.
        result =
          policyDenied || approvalRefused
            ? err.message
            : toolErrorText(tc.function.name, err, args);
      }

      const questionRecord = toolResultQuestionRecord(result);
      if (questionRecord && modelContext?.conversation) {
        rememberQuestionRecord(modelContext.conversation, tc.id, questionRecord);
      }
      this.postResult(tc, toolResultText(result), args, convId, effects.post, questionRecord);
      messages.push(toolResultMessage(tc, toolResultContent(result), startedAt));
    }
  }

  /** Handler-side redirects use the same metadata, chat rules and queue as direct calls. */
  private async requestFetchRedirectApproval(
    url: string,
    tc: ToolCall,
    args: Record<string, unknown>,
    reg: RegisteredTool,
    context: ToolDispatchRoundContext,
    grant: ApprovalGrantRecord,
  ): Promise<void> {
    const redirectArgs = { ...args, url };
    const cached = await readToolApprovalMetadata(reg, redirectArgs, context.convId);
    const evaluation = evaluateToolApproval(
      tc,
      reg,
      redirectArgs,
      context,
      cached,
      this.toolRegistry,
    );
    const metadata = evaluation.approvalMetadata;
    if (!metadata) throw new Error('web_fetch redirect approval metadata is missing.');
    if (metadata.cardTextOnly) return;
    const outcome = await this.requestToolApproval(tc, redirectArgs, evaluation, context, grant);
    if (outcome !== 'approved') {
      throw new ToolApprovalRefusal(
        `${toolApprovalResult(tc.function.name, outcome)} Redirect host: ${new URL(url).hostname}.`,
      );
    }
  }

  /** Shared by direct calls and redirects so chat rules, cards and auto-answers cannot drift. */
  private async requestToolApproval(
    tc: ToolCall,
    args: Record<string, unknown>,
    evaluation: ReturnType<typeof evaluateToolApproval>,
    context: ToolDispatchRoundContext,
    grant: ApprovalGrantRecord,
  ): Promise<ToolApprovalOutcome> {
    const { approvalMetadata, isDangerous, exitInput, exitVerdict } = evaluation;
    const chatRule =
      exitVerdict.card && context.convId !== undefined
        ? this.chatRuleApproval?.decide({
            ...exitInput,
            args,
            approvalMetadata,
            exitVerdict,
            mutationPaths: evaluation.mutationPaths,
            outsideMutationPaths: evaluation.outsideMutationPaths,
            conversationId: context.convId,
            conversation: context.modelContext?.conversation,
          })
        : undefined;
    if (!exitVerdict.card || chatRule?.kind === 'answered') return 'approved';
    const raw = JSON.stringify(args, null, 2);
    const fallbackDetail = raw.length > 300 ? raw.slice(0, 300) + '\n…' : raw;
    const detail =
      approvalMetadata?.detail ??
      (tc.function.name === 'delete_file' ? await describeDelete(args) : fallbackDetail);
    const callOptions = approvalCallOptions(
      approvalMetadata,
      exitVerdict,
      chatRule,
      exitInput.reachesOut,
    );
    callOptions.grant = grant;
    return this.requestApproval(
      tc.function.name,
      detail,
      isDangerous,
      context.convId,
      context.signal,
      callOptions,
    );
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
