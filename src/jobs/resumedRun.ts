/**
 * Closing a job run the owner stopped and then finished by hand.
 *
 * A stopped `agent_task` turn is a real failure: `AgentTaskRunner` writes a
 * `failed` row (`the turn was cancelled`), counts it against the job, and tells
 * Telegram. When the owner then types "Resume" in that same job chat — the chat
 * `state.conversation_id` names — and the work completes, nothing links that
 * turn back to the job, so the sessions-panel card stays "failed … failing ×1"
 * and `last_ok_at` stays on the previous run forever. This module writes what
 * the reconciliation needs: one `ok` run row, and the three state fields that
 * turn the card green.
 *
 * **What says this turn belongs to this job, and to this run:** four checks,
 * all in `resumedRunDecision` — `state.conversation_id` must equal the
 * conversation the turn ran in; `state.task_run` must be null; the chat must
 * not be unattended; and `turnStartedAt` must be later than the last row. The
 * second and third are what keep a job's own turn from closing its own
 * cancelled row: while `SendPipeline`'s post-turn hook runs, the runner has
 * not yet disposed its unattended marker or cleared `task_run` (it does both
 * after `send()` returns, in its `finally`), so the job's completed turn fails
 * both guards and the row it writes is the runner's own.
 *
 * Only the two stopped-turn sentences are reconciled. A timeout, a config
 * error, a restart failure or any other `failed` row is evidence about the job
 * rather than about a turn the owner meant to finish, so it stays red — and so
 * does a row whose error was prefixed with a stale-build window, because the
 * match is exact.
 *
 * The schedule is deliberately left alone: `next_due_at` and `last_observation`
 * are already correct, and a check-driven job will report its change again on
 * the next tick rather than this one guessing which observation the owner's
 * turn acted on. There is no Telegram delivery either: the owner was in the
 * chat and already has the answer.
 *
 * **What cancels it:** nothing waits. The whole reconciliation is one
 * fire-and-forget promise chain — no timer, no child process, no queue — and
 * every failure is caught and logged with the job id, so a turn never fails,
 * stalls or blocks because a reconciliation could not happen.
 *
 * **The once-guard:** the written `ok` row becomes the last row, so the next
 * completed turn in the same chat matches nothing. No flag, no state field.
 */
import type { ContextThresholdAction } from '../sidebar/ContextBudgetPublisher';
import type { RequestChainContext } from '../sidebar/RequestChainLifecycle';
import type { ConversationRuntime } from '../sidebar/sessionTypes';
import type { ForgeTurnOutcome } from '../sidebar/turnOutcome';
import { unattendedConversations } from '../sidebar/unattendedConversations';
import { getLogger } from '../util/logger';
import { CANCELLED_TURN_ERROR, INTERRUPTED_TURN_ERROR } from './agentTaskReport';
import { JobStore } from './JobStore';
import { truncate } from './jobDescribe';
import type { JobFile, JobState, RunRow } from './jobSchema';

/** The prefix every reconciled row carries, so the card says how it went green. */
export const RESUMED_RUN_SUMMARY_PREFIX = 'resumed by the owner after a stopped run: ';

/** What a turn that answered with nothing contributes to that summary. */
export const RESUMED_RUN_NO_REPLY = '(no reply text)';

/** The longest first line a reconciled summary keeps (the panel shows 120). */
export const RESUMED_RUN_SUMMARY_MAX_CHARS = 200;

/** What a reconciliation writes: the row to append and the state to patch. */
export interface ResumedRunDecision {
  /** `at` is the owner's turn start, not the stopped run's, so the log stays ordered. */
  row: RunRow;
  /** Exactly `consecutive_failures`, `last_ok_at` and `last_run_at` — nothing else. */
  patch: Partial<JobState>;
}

/** The first line of a turn's answer, trimmed for the summary, or the no-reply text. */
export function resumedRunSummary(finalText: string): string {
  for (const line of finalText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    return RESUMED_RUN_SUMMARY_PREFIX + truncate(trimmed, RESUMED_RUN_SUMMARY_MAX_CHARS);
  }
  return RESUMED_RUN_SUMMARY_PREFIX + RESUMED_RUN_NO_REPLY;
}

/**
 * The pure half: given what the store says about one job and what just happened
 * in a chat, decide whether that turn closes that job's stopped run. Returns
 * `null` for every case where it does not, so the caller writes nothing.
 *
 * `finalText` is the owner's turn answer (the row's summary comes from it) and
 * `now` is the clock the state patch stamps; both are parameters rather than
 * reads so a test can pin them instead of racing a wall clock.
 */
export function resumedRunDecision(
  jobFile: JobFile,
  lastRow: RunRow | null,
  conversationId: string,
  turnStartedAt: number,
  finalText: string,
  now: number = Date.now(),
): ResumedRunDecision | null {
  // A run the owner stopped, and nothing since: any other last row means the
  // job already moved on, or failed for a reason this turn cannot repair.
  if (!lastRow || lastRow.outcome !== 'failed') return null;
  if (lastRow.error !== CANCELLED_TURN_ERROR && lastRow.error !== INTERRUPTED_TURN_ERROR) {
    return null;
  }
  // The chat must be the one this job owns, and the job must have no run in
  // flight: a `task_run` means the job's own turn is running (or its stale
  // heartbeat is), and that turn must never close its own cancelled row.
  if (jobFile.state.conversation_id !== conversationId) return null;
  if (jobFile.state.task_run !== null) return null;
  // The same thing said a second way, for the window where the marker outlives
  // the state read: an unattended chat is a job run, not an owner finishing up.
  if (unattendedConversations.has(conversationId)) return null;
  // The turn has to start after the stopped run's row, or it is that run itself.
  if (!(turnStartedAt > lastRow.at)) return null;
  return {
    row: {
      at: turnStartedAt,
      late: false,
      outcome: 'ok',
      changed: true,
      summary: resumedRunSummary(finalText),
      delivered: 0,
      resumed: true,
    },
    patch: { consecutive_failures: 0, last_ok_at: now, last_run_at: now },
  };
}

/**
 * The async half, run after every completed turn: find the job whose chat this
 * is, read its last run row, and write the reconciliation when the decision
 * says so. `loadAll()` is the index — a chat is linked to a job only by
 * `state.conversation_id`, so there is no second table to keep in step.
 *
 * The decision is re-run against a fresh read before anything is written: a job
 * deleted in another window, or a run the scheduler started in the meantime,
 * would otherwise land a row under a newer one, or revive a deleted job's
 * `state/<id>.json` through `patchState`.
 *
 * Never throws: an unreadable store, a torn run log or a failed write is logged
 * with the job id and the reason, and the card stays red until the next run.
 */
export async function recordResumedRun(
  store: JobStore,
  conversationId: string,
  turnStartedAt: number,
  finalText: string,
  now: number = Date.now(),
): Promise<void> {
  const log = getLogger();
  let jobId: string | undefined;
  try {
    for (const listed of await store.loadAll()) {
      if (listed.state.conversation_id !== conversationId) continue;
      jobId = listed.job.id;
      const runs = await store.readRuns(listed.job.id);
      const decision = resumedRunDecision(
        listed,
        runs.length > 0 ? runs[runs.length - 1] : null,
        conversationId,
        turnStartedAt,
        finalText,
        now,
      );
      if (!decision) return;
      const fresh = await store.load(listed.job.id);
      if (!fresh) return; // deleted since the listing: nothing left to reconcile
      const freshRuns = await store.readRuns(listed.job.id);
      const stillOpen = resumedRunDecision(
        fresh,
        freshRuns.length > 0 ? freshRuns[freshRuns.length - 1] : null,
        conversationId,
        turnStartedAt,
        finalText,
        now,
      );
      if (!stillOpen) return; // a newer row, or a run started in the meantime
      await store.appendRun(listed.job.id, decision.row);
      store.patchState(listed.job.id, decision.patch);
      return;
    }
  } catch (err) {
    log.error(
      `[resumedRun] could not close a stopped run for chat ${conversationId}` +
        `${jobId ? ` (job ${jobId})` : ''}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** The store the sidebar reconciles through: the same `~/.forge/jobs` tree the
 *  panel, the scheduler and `manage_jobs` read. `JobStore` holds no cache —
 *  every read goes to disk — so a second instance in the same process cannot
 *  diverge from the one the panel holds, and the panel's own `fs.watch` on
 *  `runs/` is what turns the card green after this write. */
const sidebarJobsStore = new JobStore();

/** The post-turn context policy, as `SendPipeline` needs it wrapped. */
export interface AfterTurnPolicy {
  evaluateAfterTurn(
    conv: ConversationRuntime,
    chain: RequestChainContext,
  ): Promise<ContextThresholdAction | undefined>;
}

/**
 * The start of the turn that just finished. `SendPipeline` knows the prompt's
 * creation time, but `evaluateAfterTurn` is handed only the conversation, the
 * chain and the turn, and the transcript already carries that time on the
 * message the turn began with: the last user message. A record with no stamp
 * falls back to now, which still passes `turnStartedAt > lastRow.at` for a run
 * that stopped earlier.
 */
export function lastTurnStartAt(conv: ConversationRuntime): number {
  for (let index = conv.messages.length - 1; index >= 0; index--) {
    const message = conv.messages[index];
    if (message?.role !== 'user') continue;
    return typeof message.createdAt === 'number' ? message.createdAt : Date.now();
  }
  return Date.now();
}

/**
 * Wrap the post-turn context policy so a completed turn in a job's chat first
 * closes the run the owner stopped there. Only a `completed` turn counts: a
 * failed, cancelled or interrupted one has nothing to reconcile, and a job's
 * own turn is refused by the guards inside `resumedRunDecision` rather than by
 * a check here, so one decision answers both questions.
 */
export function withResumedRunReconciliation(
  policy: AfterTurnPolicy,
  store: JobStore = sidebarJobsStore,
): (
  conv: ConversationRuntime,
  chain: RequestChainContext,
  turn: ForgeTurnOutcome,
) => Promise<ContextThresholdAction | undefined> {
  return (conv, chain, turn) => {
    if (turn.kind === 'completed') {
      void recordResumedRun(store, conv.id, lastTurnStartAt(conv), turn.finalText);
    }
    return policy.evaluateAfterTurn(conv, chain);
  };
}
