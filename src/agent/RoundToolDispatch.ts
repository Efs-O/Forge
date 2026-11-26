import type { ToolCall } from '../llm/types';
import type { StreamedAssistantTurn } from './StreamedAssistantTurn';
import {
  loopRecoveryNudge,
  MAX_LOOP_RECOVERIES,
  ToolLoopDetectedError,
  ToolLoopGuard,
} from './ToolLoopGuard';
import type { ToolCallingLoopOptions } from './toolCallingLoopTypes';

/**
 * One tool-calling round that ended in tool calls: complete the assistant turn,
 * narrate it, dispatch the calls, run the repetition guard over the results,
 * then drain any tells waiting for a safe gap.
 *
 * The guard and its recovery counter are this round's state alone, so they live
 * here rather than in the loop that decides whether the turn goes on.
 */
export class RoundToolDispatch {
  private loopGuard = new ToolLoopGuard();
  private loopRecoveries = 0;

  constructor(private readonly options: ToolCallingLoopOptions) {}

  /**
   * Folds the results into the transcript. Throws when the repetition guard ends
   * the turn; returns once the round is settled and the next one may start.
   */
  async run(
    streamedAssistant: StreamedAssistantTurn,
    calls: ToolCall[],
    assistantContent: string,
    assistantReasoning: string,
  ): Promise<void> {
    // Carry this round's reasoning on the tool-call turn. rawReasoning resets
    // every round, so dropping it here discarded the model's thinking for every
    // round that ended in a tool call — only the final round's survived, and
    // the sidebar's reasoning bubbles collapsed to one when the turn ended.
    // A model may narrate its next action before emitting the tool call. That
    // commentary has already streamed into the sidebar, so retain it on the
    // protocol turn as well; otherwise the next session sync replaces the
    // live row with `content: null` and the visible text disappears.
    streamedAssistant.completeToolCall(calls, assistantContent, assistantReasoning);
    this.options.onMessagesChanged?.();
    // A question is the boundary of this round. Keep any pre-question
    // commentary in the transcript, but do not send it as a separate remote
    // notification while the user is waiting for the question itself. Only a
    // round that is *purely* a question suppresses the narration: a mixed
    // round (e.g. write_file + ask_user) did real work the user should hear
    // about, so its commentary still reaches remote surfaces.
    const isQuestionOnlyRound = calls.every((call) => call.function.name === 'ask_user');
    if (assistantContent.trim() && !isQuestionOnlyRound)
      this.options.onRoundNarration?.(assistantContent);
    const beforeDispatch = this.options.messages.length;
    await this.options.dispatchToolCalls(calls, this.options.messages);
    let recoverLoop = false;
    try {
      this.loopGuard.afterRound(
        calls,
        this.options.messages.slice(beforeDispatch),
        this.options.isMutatingTool,
      );
    } catch (error) {
      if (error instanceof ToolLoopDetectedError && this.loopRecoveries < MAX_LOOP_RECOVERIES) {
        this.loopRecoveries++;
        this.loopGuard = new ToolLoopGuard();
        // Internal: the model and the session log need it; the sidebar must not
        // render Forge's nudge as something the user typed, and a plain user row
        // opens a turn in the control server's counters for a turn that is still
        // running.
        this.options.messages.push({
          role: 'user',
          content: loopRecoveryNudge(error.message, MAX_LOOP_RECOVERIES - this.loopRecoveries),
          internal: true,
        });
        recoverLoop = true;
      } else {
        if (error instanceof ToolLoopDetectedError) this.options.onRepeatedCall?.();
        throw error;
      }
    } finally {
      // The guard may prepend a warning to a tool result. Persist after that
      // mutation so the session row matches the result the next request sees.
      this.options.onMessagesChanged?.();
    }
    if (recoverLoop) return;
    const drained = await this.options.drainTells?.();
    if (drained && drained.messages.length > 0) {
      this.options.messages.push(...drained.messages);
      this.options.onMessagesChanged?.();
    }
    // Settle always runs when present, even with no messages: a failing tell
    // source yields no messages but still must surface its error, so the
    // rethrow from settle cannot be skipped by an empty drain. When messages
    // were pushed, persist ran above, so the claim is settled only once the
    // injected turn is durable; if that persist threw we never reach here and
    // the record stays `running` for the store's restart recovery.
    await drained?.settle?.();
  }
}
