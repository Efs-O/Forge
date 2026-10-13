/**
 * The elapsed-time note (`elapsed_time_note` in the config).
 *
 * A local model can spend an hour reading before it writes anything. On
 * 2026-10-12 a turn read for about 75 minutes until its supervisor steered it with
 * one plain sentence — "You have the context you need. Stop reading and keep
 * going." — after which it wrote the code and CI went green. This is that
 * sentence, sent by Forge itself at the first tool-round gap after a timer.
 *
 * Two timers, one class:
 * - **The model's own check-in** (phase 2, `set_checkin`): the model estimates
 *   how long the task should take and where it expects to be by then, and the
 *   note holds it to its own estimate rather than to Forge's opinion.
 * - **The fallback** (phase 1, `after_minutes`): a fixed note for a model that
 *   sets none.
 * The config block gates both, and the tool: no block, no tool, no note, no
 * schema tokens.
 *
 * A "task" is what the user typed, so it shares `taskStart()`'s boundary in
 * `preserveThinking.ts`: an auto-compaction resume (`internal`) or a message
 * told mid-turn belongs to the task already running and does not restart the
 * clock. The note is delivered through the mid-turn tell path, so it lands at
 * the end of the transcript and keeps the prompt cache; it is flagged
 * `internal` (no user bubble, logged as Forge's own line) and `midTurn` (it
 * does not end the task for `preserve_thinking`).
 *
 * Deliberately small: no timer object, no re-arming from Forge, no snooze. The
 * clock is read only at a drain, so a round that never reaches a tool-round gap
 * gets no note until the next one.
 */

import type { ChatMessage } from '../llm/types';
import { getLogger } from '../util/logger';
import type { MidTurnTellSource } from './MidTurnTellDrain';

const log = getLogger();

const MINUTE_MS = 60_000;

/** Where the model expects to be when its check-in fires. An enum, not prose. */
export type CheckinStage = 'writing' | 'testing' | 'done';

/** The wording both the note and the tool result use, so they cannot drift. */
export const CHECKIN_STAGE_PHRASE: Record<CheckinStage, string> = {
  writing: 'writing the code or the report',
  testing: 'running tests',
  done: 'finished',
};

/** Phase 1's fixed note. `{minutes}` is the real elapsed time, not the setting. */
function fallbackNoteText(minutes: number): string {
  return (
    `[Forge] This task has been running for ${minutes} minutes. This is not a ` +
    'deadline: do not skip checks, tests or verification. If you already have the ' +
    'context you need, stop reading and move on to the next step: write the code, ' +
    'the report or the answer.'
  );
}

/** Phase 2's note: it quotes the model's own estimate back to it. */
function checkinNoteText(setMinutes: number, byThen: CheckinStage): string {
  return (
    `[Forge] Check-in: ${setMinutes} minutes ago you estimated you would be ` +
    `${CHECKIN_STAGE_PHRASE[byThen]} by now. This is not a deadline: do not skip ` +
    'checks, tests or verification. If you already have the context you need, move ' +
    'on to the next step. If the task is bigger than you estimated, call ' +
    'set_checkin again with a new estimate.'
  );
}

interface TaskClock {
  /** When the user-typed prompt started the task — the fallback clock. */
  startedAt: number;
  /** One note per timer: per check-in, or per task when the model set none. */
  fired: boolean;
  /** The model's own estimate, written by `set_checkin`. */
  checkin?: { setAt: number; minutes: number; byThen: CheckinStage };
  /** Last committed compaction: the timer counts from here, the note's minutes do not. */
  restartedAt?: number;
}

export class ElapsedTimeNote {
  /** In memory only: a handful of numbers per conversation, dropped with the host. */
  private readonly tasks = new Map<string, TaskClock>();

  constructor(
    /** Read at every drain, so turning the note on applies to the running task. */
    private readonly getAfterMinutes: () => number | undefined,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Called when a user-typed prompt starts a task. Resets the clock and clears any check-in. */
  taskStarted(conversationId: string): void {
    this.tasks.set(conversationId, { startedAt: this.now(), fired: false });
  }

  /**
   * `set_checkin`: the model's estimate becomes the clock, and re-arming
   * replaces it (that is how it re-plans a task that turned out bigger).
   * Returns when the check-in is due so the tool can name the clock time.
   */
  setCheckin(conversationId: string, minutes: number, byThen: CheckinStage): { dueAt: number } {
    const setAt = this.now();
    // A check-in can arrive for a conversation with no tracked task — a session
    // restored across a reload, or a turn whose prompt predates this host.
    const clock = this.tasks.get(conversationId) ?? { startedAt: setAt, fired: false };
    clock.checkin = { setAt, minutes, byThen };
    clock.fired = false;
    this.tasks.set(conversationId, clock);
    log.debug(`[elapsed-note] conv=${conversationId} checkin ${minutes} min by_then=${byThen}`);
    return { dueAt: setAt + minutes * MINUTE_MS };
  }

  /**
   * A committed compaction restarts the clock and re-arms the note.
   *
   * A compaction keeps the user's own words verbatim but deliberately drops
   * Forge's internal messages (`compactionUserContext.ts`), so the summarizer
   * can lose both the note and the model's memory of setting the timer. It
   * restarts from the compaction rather than firing at once: re-reading files
   * after a compaction is normal.
   */
  compacted(conversationId: string): void {
    const clock = this.tasks.get(conversationId);
    if (!clock) return;
    // Only the trigger restarts. `setAt` and `startedAt` stay, so the note still
    // states how long ago the estimate was made or the task began.
    clock.restartedAt = this.now();
    clock.fired = false;
    log.debug(`[elapsed-note] conv=${conversationId} clock restarted by compaction`);
  }

  /** MidTurnTellSource: the note for whichever timer is running, at most once each. */
  readonly source: MidTurnTellSource = async (conversationId) => {
    const afterMinutes = this.getAfterMinutes();
    if (afterMinutes === undefined) return { messages: [] };
    const clock = this.tasks.get(conversationId);
    if (!clock || clock.fired) return { messages: [] };
    // A check-in overrides the fallback entirely: the model's own estimate is
    // the timer, and the fallback does not fire alongside it.
    const checkin = clock.checkin;
    const base = checkin ? checkin.setAt : clock.startedAt;
    const from = Math.max(base, clock.restartedAt ?? base);
    const limit = checkin ? checkin.minutes : afterMinutes;
    if (Math.floor((this.now() - from) / MINUTE_MS) < limit) return { messages: [] };
    // The note states the real elapsed time, rounded down — not the setting.
    const elapsedMinutes = Math.floor((this.now() - base) / MINUTE_MS);
    clock.fired = true;
    log.debug(
      `[elapsed-note] conv=${conversationId} fired after ${elapsedMinutes} min ` +
        `${checkin ? '(checkin)' : '(fallback)'}`,
    );
    const message: ChatMessage = {
      role: 'user',
      content: checkin
        ? checkinNoteText(elapsedMinutes, checkin.byThen)
        : fallbackNoteText(elapsedMinutes),
      internal: true,
      midTurn: true,
    };
    return { messages: [message] };
  };
}
