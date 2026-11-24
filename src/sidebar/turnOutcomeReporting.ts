/**
 * What a turn that did not finish means, and what the owner hears about it.
 * Split out of `ModelTurn.ts`, which keeps the request assembly: nothing here
 * decides what is sent. Both cut-off paths are here together, because they are
 * one concern — the loop *throws* on the round cap and on exhausted context,
 * and only `finish_reason: length` comes back through a normal return.
 */
import type { ModelConfig } from '../config/types';
import { isTurnCutOffError, ROUND_CAP_INCOMPLETE_PREFIX } from '../agent/ToolCallingLoop';
import type { ToolCallingLoopResult } from '../agent/ToolCallingLoop';
import type { ConversationRuntime } from './sessionTypes';
import type { HostToWebview } from './messageBridge';
import type { TurnLifecycle } from './TurnLifecycle';
import type { ModelTurnContext } from './ModelTurn';
import { runningBackgroundExecutionsNotice } from './backgroundExitNotice';

/**
 * Records turns that ended for want of room. `runToolCallingLoop` *throws* on
 * the round cap and on exhausted context, so both have to be caught here —
 * only `finish_reason: length` comes back through a normal return.
 */
export async function trackTurnCompletion<T>(
  lifecycle: TurnLifecycle,
  convId: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isTurnCutOffError(err)) lifecycle.markIncomplete(convId, (err as Error).message);
    throw err;
  }
}

/**
 * Publishes the outcome once the loop has returned: the final context-bar tick,
 * then a notice for each way the turn stopped short of finishing.
 */
export function publishTurnOutcome(input: {
  ctx: Pick<ModelTurnContext, 'lifecycle' | 'onContextChanged'>;
  conv: ConversationRuntime;
  model: ModelConfig;
  maxRounds: number;
  postC: (msg: HostToWebview) => void;
  result: ToolCallingLoopResult;
}): void {
  const { ctx, conv, model, maxRounds, postC, result } = input;
  // Final publish for the turn. The per-round ticks above are throttled, so
  // the last one may have been coalesced away.
  ctx.onContextChanged?.(conv.id);
  // Cut off by the output ceiling: the reply stopped mid-thought, so the work
  // is unfinished even though the loop returned normally.
  if (result.finishReason === 'length') {
    ctx.lifecycle.markIncomplete(conv.id, 'the reply was cut off by the output limit');
    // An empty cut-off reply needs an explicit cause and recovery path.
    if (!result.finalText) {
      postC({
        type: 'notice',
        message:
          'Forge: the model used its whole output budget on reasoning and was cut off ' +
          'before answering. The context is nearly full — run /compact, or lower ' +
          `\`--reasoning-budget\` for "${model.name}".`,
      });
    }
  }
  // The model ended its own generation mid-thought (see ToolCallingLoop). Not
  // the output limit, so /compact is not the remedy; a plain retry usually is.
  if (result.stoppedWhileReasoning) {
    ctx.lifecycle.markIncomplete(conv.id, 'the model stopped while still reasoning');
    postC({
      type: 'notice',
      // Warning, so a remote chat gets a push: the user must send "continue".
      severity: 'warning',
      message:
        'Forge: the model ended its reply mid-thought twice (the automatic retry with ' +
        'thinking off also produced nothing). Say "continue" to resume.',
    });
  }
  // Same shape as the `length` case above: the loop returned normally, but the
  // request is unfinished. Marking it is what lets the post-turn resume pick it
  // up — without this the turn simply stopped, and only a manual "continue"
  // restarted it (with a fresh, equally exhaustible budget).
  if (result.hitRoundCap) {
    ctx.lifecycle.markIncomplete(conv.id, `${ROUND_CAP_INCOMPLETE_PREFIX} (${maxRounds})`);
    // Name the knob. Hitting the cap on real work is a budgeting problem the
    // user can fix, and without this the stop looked like an internal failure
    // with no recourse but to retype "continue" for another identical budget.
    postC({
      type: 'notice',
      message:
        `Forge: stopped after ${maxRounds} tool rounds with the task unfinished. ` +
        `Send a smaller step, or raise \`max_tool_rounds\` on "${model.name}" ` +
        `(or its group) if this task legitimately needs more.`,
    });
  }
  const running = runningBackgroundExecutionsNotice(conv.id);
  if (running) postC({ type: 'notice', message: running });
}
