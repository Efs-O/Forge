import type { HostToWebview } from './messageBridge';
import { applyToolNameAlias, recordToolNameAliasHit } from '../tools/toolNameAliases';
import type { ChatMessage, ToolCall } from '../llm/types';
import type { ToolRegistry } from '../tools/ToolRegistry';
import type { ToolFailureTracker } from '../tools/StripTools';
import { isJsonObject, parseJson } from '../tools/jsonInput';
import { READ_ONLY_PERMISSIONS } from '../tools/toolContract';
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
  'grep_search',
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
  /** The success reset, plus the one refusal that is the model's protocol
   *  failing rather than the tool's (audit R1): engine-folded markup. A tool's
   *  own error no longer changes the protocol, so nothing else records failures. */
  failureTracker: Pick<ToolFailureTracker, 'reset' | 'recordNativeParseFailure'>;
}

export interface BufferedToolDispatchEffects extends ToolDispatchEffects {
  historyLength: number;
  posts: HostToWebview[];
  /** Tracker updates in the order they happened: a failure recorded before a
   *  call that ran must be applied before that call's reset, or the good call
   *  would not clear the streak the broken one raised. */
  failureTrackerUpdates: FailureTrackerUpdate[];
}

type FailureTrackerUpdate =
  | { kind: 'reset'; conversationId: string | undefined }
  | { kind: 'protocolFailure'; conversationId: string | undefined };

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
  // Resolve a foreign name first, or an aliased read (`glob`, `ls`, `search_code`)
  // is not parallel-eligible and runs serially through dispatchOne. Same rule as
  // `toolCallPreflight.ts`: only when nothing is registered under that name, and
  // the hit is counted here when this path is the one that resolved it.
  if (!toolRegistry.get(tc.function.name)) {
    const aliased = applyToolNameAlias(tc);
    if (aliased) recordToolNameAliasHit(aliased);
  }
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
      reset: (conversationId) => {
        failureTrackerUpdates.push({ kind: 'reset', conversationId });
      },
      recordNativeParseFailure: (conversationId) => {
        failureTrackerUpdates.push({ kind: 'protocolFailure', conversationId });
      },
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
  failureTracker: Pick<ToolFailureTracker, 'reset' | 'recordNativeParseFailure'>,
  post: (msg: HostToWebview) => void,
): void {
  for (const update of buffered.failureTrackerUpdates) {
    if (update.kind === 'reset') failureTracker.reset(update.conversationId);
    else failureTracker.recordNativeParseFailure(update.conversationId);
  }
  for (const msg of buffered.posts) post(msg);
  messages.push(...buffered.messages.slice(buffered.historyLength));
}

/** One dispatch whose result is held back so the model still sees results in call
 *  order while a parked call waits for its card. `promise` never rejects: the
 *  failure is recorded on the slot and rethrown when the slot reaches the head of
 *  the queue, which is the position its own error would have been reported in. */
interface HeldDispatch {
  effects: BufferedToolDispatchEffects;
  promise: Promise<void>;
  settled: boolean;
  failed: boolean;
  error?: unknown;
}

/** Runs the maximal consecutive native-read runs, dispatching every boundary call in place.
 *
 *  A gated call that touches no workspace file is PARKED: its card opens and its
 *  dispatch runs on while the round carries on with the local reads behind it, so
 *  a read never waits for an owner who may be minutes away (2026-11-13 lab: one
 *  ungated call waited 12 min behind someone else's card). A call that mutates is
 *  never parked, and a call that must keep its position waits for everything
 *  parked ahead of it — so a write still runs before the read of the file it wrote.
 */
export async function dispatchWithParallelReads(
  calls: readonly ToolCall[],
  context: ToolDispatchRoundContext,
  toolRegistry: ToolRegistry,
  messages: ChatMessage[],
  failureTracker: Pick<ToolFailureTracker, 'reset' | 'recordNativeParseFailure'>,
  post: (msg: HostToWebview) => void,
  dispatchSerial: (call: ToolCall, approval?: CachedToolApproval) => Promise<void>,
  dispatchBuffered: (
    call: ToolCall,
    approval: CachedToolApproval | undefined,
    effects: BufferedToolDispatchEffects,
  ) => Promise<void>,
): Promise<void> {
  /** Results waiting their turn, oldest call first. */
  const held: HeldDispatch[] = [];
  const commitHead = (): void => {
    const head = held.shift();
    if (!head) return;
    if (head.failed) throw head.error;
    commitBufferedToolDispatchEffects(head.effects, messages, failureTracker, post);
  };
  /** Commit everything the front of the queue has made ready, in call order. */
  const commitReady = (): void => {
    while (held.length > 0 && held[0]!.settled) commitHead();
  };
  /** Run the held results out, but never let one of them replace an error that is
   *  already in flight: the round is failing, and the first error is the one worth
   *  reporting. Every slot still commits, so no tool result goes missing. */
  const drainHeldQuietly = async (): Promise<void> => {
    while (held.length > 0) {
      const head = held[0]!;
      if (!head.settled) await head.promise;
      try {
        commitHead();
      } catch {
        /* the caller's error outranks this one */
      }
    }
  };
  /** Run the round out: every held result must reach the model before the round ends. */
  const drainHeld = async (): Promise<void> => {
    while (held.length > 0) {
      const head = held[0]!;
      if (!head.settled) await head.promise;
      commitHead();
    }
  };
  /** Hold a dispatch that has already started, so it commits at its own position. */
  const hold = (effects: BufferedToolDispatchEffects, run: () => Promise<void>): void => {
    const slot: HeldDispatch = {
      effects,
      settled: false,
      failed: false,
      promise: Promise.resolve(),
    };
    slot.promise = run().then(
      () => {
        slot.settled = true;
      },
      (error: unknown) => {
        slot.failed = true;
        slot.settled = true;
        slot.error = error;
      },
    );
    held.push(slot);
  };
  /** Emit one buffered result: straight out when nothing is parked ahead of it,
   *  otherwise held so the parked call keeps its place in what the model reads. */
  const emit = (effects: BufferedToolDispatchEffects): void => {
    if (held.length === 0) {
      commitBufferedToolDispatchEffects(effects, messages, failureTracker, post);
      return;
    }
    held.push({ effects, settled: true, failed: false, promise: Promise.resolve() });
    commitReady();
  };

  let callIndex = 0;
  let pendingCheck: ParallelReadCheck | undefined;
  try {
    while (callIndex < calls.length) {
      const call = calls[callIndex]!;
      const check = context.signal?.aborted
        ? { eligible: false }
        : (pendingCheck ?? (await checkParallelReadCall(call, context, toolRegistry)));
      pendingCheck = undefined;
      if (!check.eligible) {
        // A boundary call keeps its position: anything parked ahead of it runs first.
        await drainHeld();
        if (canParkForApproval(call, toolRegistry, context)) {
          const effects = createBufferedToolDispatchEffects(messages);
          hold(effects, () => dispatchBuffered(call, check.approval, effects));
        } else {
          await dispatchSerial(call, check.approval);
        }
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
        if (held.length === 0) {
          await dispatchSerial(call, check.approval);
        } else {
          const effects = createBufferedToolDispatchEffects(messages);
          await dispatchBuffered(call, check.approval, effects);
          emit(effects);
        }
      } else {
        const outcomes = await runParallelReadBatch(run, context.signal, async (candidate) => {
          const effects = createBufferedToolDispatchEffects(messages);
          await dispatchBuffered(candidate.toolCall, candidate.approval, effects);
          return effects;
        });
        for (const outcome of outcomes) {
          if (outcome.kind === 'failed') {
            if (held.length === 0) throw outcome.error;
            held.push({
              effects: createBufferedToolDispatchEffects(messages),
              settled: true,
              failed: true,
              error: outcome.error,
              promise: Promise.resolve(),
            });
            break;
          }
          if (outcome.kind === 'not-started') break;
          emit(outcome.value);
        }
      }
      callIndex = nextIndex;
    }
    // The round can end with a parked call still in `held`, and that parked call can
    // have failed. Draining inside the `try` is what routes its error through
    // `drainHeldQuietly` below, so every OTHER held result still commits: a drain
    // after the `catch` threw past it, and the calls behind the failed one lost
    // their tool-result rows — a call the model sent that never answered.
    await drainHeld();
  } catch (error) {
    // A parked call still owes the model a tool-result row: commit whatever the
    // parked calls produced before this error propagates. A transcript with a call
    // that never answered is worse than the error the caller is about to report,
    // and the caller already has the worse of the two errors in hand.
    await drainHeldQuietly();
    throw error;
  }
}

/**
 * May this call be parked while its card waits? Only a call that changes nothing:
 * the permission tiers the loop guard already treats as read-only, and a tool that
 * declares no mutation. That is what makes the rule safe rather than guessed —
 * `shell`, `desktop_press` and `ask_local_agent` all sit outside those tiers, and
 * each can write a workspace file without saying so in its schema (review, 2026-11-13:
 * parking a gated `shell` let a later read answer from BEFORE the command wrote).
 * The call must also be one that can actually raise a card, or parking a plain read
 * would run it early for no reason and reorder every existing round.
 * One parked call at a time: the second gated call in a round keeps today's behaviour.
 */
function canParkForApproval(
  call: ToolCall,
  toolRegistry: ToolRegistry,
  context: ToolDispatchRoundContext,
): boolean {
  if (context.signal?.aborted) return false;
  const reg = toolRegistry.get(call.function.name);
  if (!reg) return false;
  if (reg.mutation !== undefined || reg.workspaceStateMutation === true) return false;
  if (!READ_ONLY_PERMISSIONS.has(reg.permission)) return false;
  return reg.approval !== undefined || reg.reachesOut !== undefined;
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
