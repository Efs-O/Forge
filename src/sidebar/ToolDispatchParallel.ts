import type { HostToWebview } from './messageBridge';
import type { ChatMessage, ToolCall } from '../llm/types';
import type { ToolRegistry } from '../tools/ToolRegistry';
import type { ToolFailureTracker } from '../tools/StripTools';
import { isJsonObject, parseJson } from '../tools/jsonInput';
import {
  evaluateToolApproval,
  readToolApprovalMetadata,
  type CachedToolApproval,
  type ToolApprovalEvaluation,
} from './toolApprovalEvaluation';
import type { ToolDispatchRoundContext } from './toolDispatchTypes';

/** Only these built-in local reads may join a parallel run; this is deliberately not a name pattern. */
const PARALLEL_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'search_code',
  'list_directory',
  'find_files',
  '__code_intel_get_diagnostics',
  'git_read',
  '__git_read_status',
  '__git_read_log',
  '__git_read_diff',
  '__git_read_blame',
  '__git_read_show',
]);

const MAX_PARALLEL_READ_CALLS = 10;

export interface ParallelReadCheck {
  eligible: boolean;
  approval?: CachedToolApproval;
}

interface ParallelReadCall {
  toolCall: ToolCall;
  approval: CachedToolApproval | undefined;
}

export interface ToolDispatchEffects {
  messages: ChatMessage[];
  post: (msg: HostToWebview) => void;
  failureTracker: Pick<ToolFailureTracker, 'record' | 'reset'>;
}

export interface BufferedToolDispatchEffects extends ToolDispatchEffects {
  historyLength: number;
  posts: HostToWebview[];
  failureTrackerUpdates: Array<{
    kind: 'record' | 'reset';
    conversationId: string | undefined;
  }>;
}

export function isParallelReadOnlyTool(name: string): boolean {
  return PARALLEL_READ_ONLY_TOOLS.has(name);
}

/**
 * Preflight one native read with the same approval policy used by the serial
 * path. Approval callbacks in this allowlist only inspect arguments/config;
 * cards and chat-rule bookkeeping remain in ToolDispatch's serial path.
 */
export async function checkParallelReadCall(
  tc: ToolCall,
  context: ToolDispatchRoundContext,
  toolRegistry: ToolRegistry,
): Promise<ParallelReadCheck> {
  if (!isParallelReadOnlyTool(tc.function.name) || context.signal?.aborted) {
    return { eligible: false };
  }
  if (context.unavailableTools?.has(tc.function.name)) return { eligible: true };

  const reg = toolRegistry.get(tc.function.name);
  if (
    !reg ||
    (reg.permission !== 'read' && reg.permission !== 'git-read') ||
    reg.mutation !== undefined ||
    reg.workspaceStateMutation === true ||
    reg.untrustedResult === true ||
    reg.reachesOut !== undefined ||
    reg.refuseBeforeApproval !== undefined
  ) {
    return { eligible: false };
  }

  // This block mirrors ToolDispatch.ts's refusal order (malformed JSON, object shape, then schema).
  const parsed = parseJson(tc.function.arguments);
  if (!parsed.ok || !isJsonObject(parsed.value)) {
    // The normal path refuses malformed arguments before it reaches approval.
    return { eligible: true };
  }

  let args: Record<string, unknown>;
  try {
    args = parsed.value;
    if (toolRegistry.invalidArgs(reg, args)) return { eligible: true };
  } catch {
    // Coercion and schema refusals also precede approval on the serial path.
    return { eligible: true };
  }

  const approval = await readToolApprovalMetadata(reg, args, context.convId);
  if (approval.kind === 'value' && approval.metadata?.reachesOut !== undefined) {
    return { eligible: false, approval };
  }
  let evaluation: ToolApprovalEvaluation;
  try {
    evaluation = evaluateToolApproval(tc, reg, args, context, approval, toolRegistry);
  } catch {
    // The call remains serial so its error is recorded at the original position.
    return { eligible: false, approval };
  }
  return { eligible: !evaluation.exitVerdict.card, approval };
}

export function createBufferedToolDispatchEffects(
  history: readonly ChatMessage[],
): BufferedToolDispatchEffects {
  const posts: HostToWebview[] = [];
  const failureTrackerUpdates: BufferedToolDispatchEffects['failureTrackerUpdates'] = [];
  const messages = [...history];
  return {
    messages,
    post: (msg) => posts.push(msg),
    failureTracker: {
      record: (conversationId) => failureTrackerUpdates.push({ kind: 'record', conversationId }),
      reset: (conversationId) => failureTrackerUpdates.push({ kind: 'reset', conversationId }),
    },
    historyLength: history.length,
    posts,
    failureTrackerUpdates,
  };
}

/** Applies each call's bookkeeping and display output in the original call order. */
export function commitBufferedToolDispatchEffects(
  buffered: BufferedToolDispatchEffects,
  messages: ChatMessage[],
  failureTracker: Pick<ToolFailureTracker, 'record' | 'reset'>,
  post: (msg: HostToWebview) => void,
): void {
  for (const update of buffered.failureTrackerUpdates) {
    failureTracker[update.kind](update.conversationId);
  }
  for (const msg of buffered.posts) post(msg);
  messages.push(...buffered.messages.slice(buffered.historyLength));
}

/** Runs the maximal consecutive native-read runs, dispatching every boundary call in place. */
export async function dispatchWithParallelReads(
  calls: readonly ToolCall[],
  context: ToolDispatchRoundContext,
  toolRegistry: ToolRegistry,
  messages: ChatMessage[],
  failureTracker: Pick<ToolFailureTracker, 'record' | 'reset'>,
  post: (msg: HostToWebview) => void,
  dispatchSerial: (call: ToolCall, approval?: CachedToolApproval) => Promise<void>,
  dispatchBuffered: (
    call: ToolCall,
    approval: CachedToolApproval | undefined,
    effects: BufferedToolDispatchEffects,
  ) => Promise<void>,
): Promise<void> {
  let callIndex = 0;
  let pendingCheck: ParallelReadCheck | undefined;
  while (callIndex < calls.length) {
    const call = calls[callIndex]!;
    const check = context.signal?.aborted
      ? { eligible: false }
      : (pendingCheck ?? (await checkParallelReadCall(call, context, toolRegistry)));
    pendingCheck = undefined;
    if (!check.eligible) {
      await dispatchSerial(call, check.approval);
      callIndex += 1;
      continue;
    }

    const run: ParallelReadCall[] = [{ toolCall: call, approval: check.approval }];
    let nextIndex = callIndex + 1;
    while (nextIndex < calls.length && !context.signal?.aborted) {
      const nextCall = calls[nextIndex]!;
      const nextCheck = await checkParallelReadCall(nextCall, context, toolRegistry);
      if (!nextCheck.eligible) {
        pendingCheck = nextCheck;
        break;
      }
      run.push({ toolCall: nextCall, approval: nextCheck.approval });
      nextIndex += 1;
    }

    if (run.length === 1) {
      await dispatchSerial(call, check.approval);
    } else {
      const outcomes = await runParallelReadBatch(run, context.signal, async (candidate) => {
        const effects = createBufferedToolDispatchEffects(messages);
        await dispatchBuffered(candidate.toolCall, candidate.approval, effects);
        return effects;
      });
      for (const outcome of outcomes) {
        if (outcome.kind === 'failed') throw outcome.error;
        if (outcome.kind === 'not-started') break;
        commitBufferedToolDispatchEffects(outcome.value, messages, failureTracker, post);
      }
    }
    callIndex = nextIndex;
  }
}

export type ParallelBatchOutcome<T> =
  | { kind: 'completed'; value: T }
  | { kind: 'failed'; error: unknown }
  | { kind: 'not-started' };

/** Runs a consecutive read-only run with at most ten active calls. */
export async function runParallelReadBatch<T, R>(
  calls: readonly T[],
  signal: AbortSignal | undefined,
  execute: (call: T, index: number) => Promise<R>,
): Promise<ParallelBatchOutcome<R>[]> {
  const outcomes: Array<ParallelBatchOutcome<R> | undefined> = new Array(calls.length);
  let nextIndex = 0;
  let stoppedByFailure = false;
  const worker = async (): Promise<void> => {
    while (!signal?.aborted && !stoppedByFailure) {
      const index = nextIndex++;
      if (index >= calls.length) return;
      try {
        outcomes[index] = { kind: 'completed', value: await execute(calls[index]!, index) };
      } catch (error) {
        outcomes[index] = { kind: 'failed', error };
        stoppedByFailure = true;
        return;
      }
    }
  };
  const workerCount = Math.min(MAX_PARALLEL_READ_CALLS, calls.length);
  await Promise.all(Array.from({ length: workerCount }, worker));

  // Unstarted calls use the same dispatcher; its aborted-signal branch records the serial cancellation result.
  for (let index = 0; index < calls.length; index += 1) {
    if (outcomes[index] !== undefined) continue;
    if (signal?.aborted && !stoppedByFailure) {
      try {
        outcomes[index] = { kind: 'completed', value: await execute(calls[index]!, index) };
      } catch (error) {
        outcomes[index] = { kind: 'failed', error };
        stoppedByFailure = true;
      }
    } else {
      outcomes[index] = { kind: 'not-started' };
    }
  }
  return outcomes.map((outcome) => outcome ?? { kind: 'not-started' });
}
