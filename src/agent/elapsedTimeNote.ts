/**
 * The elapsed-time note (`elapsed_time_note.after_minutes` in the config).
 *
 * A local model can spend an hour reading before it writes anything. On
 * 2026-10-12 a turn read for about 75 minutes until its supervisor steered it with
 * one plain sentence — "You have the context you need. Stop reading and keep
 * going." — after which it wrote the code and CI went green. This is that
 * sentence, sent by Forge itself: at most once per task, at the first
 * tool-round gap after the configured minutes.
 *
 * A "task" is what the user typed, so it shares `taskStart()`'s boundary in
 * `preserveThinking.ts`: an auto-compaction resume (`internal`) or a message
 * told mid-turn belongs to the task already running and does not restart the
 * clock. The note is delivered through the mid-turn tell path, so it lands at
 * the end of the transcript and keeps the prompt cache; it is flagged
 * `internal` (no user bubble, logged as Forge's own line) and `midTurn` (it
 * does not end the task for `preserve_thinking`).
 *
 * Deliberately small: no tool, no model-set timer, no re-arming, no snooze.
 * A round that never reaches a tool-round gap gets no note until the next one.
 */

import type { ChatMessage } from '../llm/types';
import { getLogger } from '../util/logger';
import type { MidTurnTellSource } from './MidTurnTellDrain';

const log = getLogger();

const MINUTE_MS = 60_000;

function noteText(minutes: number): string {
  return (
    `[Forge] This task has been running for ${minutes} minutes. This is not a ` +
    'deadline: do not skip checks, tests or verification. If you already have the ' +
    'context you need, stop reading and move on to the next step: write the code, ' +
    'the report or the answer.'
  );
}

export class ElapsedTimeNote {
  /** In memory only: two numbers per conversation, dropped with the host. */
  private readonly tasks = new Map<string, { startedAt: number; fired: boolean }>();

  constructor(
    /** Read at every drain, so turning the note on applies to the running task. */
    private readonly getAfterMinutes: () => number | undefined,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Called when a user-typed prompt starts a task. Resets the clock and the fired flag. */
  taskStarted(conversationId: string): void {
    this.tasks.set(conversationId, { startedAt: this.now(), fired: false });
  }

  /** MidTurnTellSource: returns the note once, after the threshold; otherwise nothing. */
  readonly source: MidTurnTellSource = async (conversationId) => {
    const afterMinutes = this.getAfterMinutes();
    if (afterMinutes === undefined) return { messages: [] };
    const task = this.tasks.get(conversationId);
    if (!task || task.fired) return { messages: [] };
    // The note states the real elapsed time, rounded down — not the setting.
    const elapsedMinutes = Math.floor((this.now() - task.startedAt) / MINUTE_MS);
    if (elapsedMinutes < afterMinutes) return { messages: [] };
    task.fired = true;
    log.debug(`[elapsed-note] conv=${conversationId} after ${elapsedMinutes} min`);
    const message: ChatMessage = {
      role: 'user',
      content: noteText(elapsedMinutes),
      internal: true,
      midTurn: true,
    };
    return { messages: [message] };
  };
}
