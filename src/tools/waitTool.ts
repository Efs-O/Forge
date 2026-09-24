import type { RegisteredTool } from './ToolRegistry';
import { localTimeOfDay } from '../util/localClock';

/**
 * Longest single pause, in seconds.
 *
 * Deliberately NOT monitor_execution's 60s ceiling: that one is a polling
 * interval on a wait that returns early the moment the process exits, so it
 * caps a check, not a duration. Nothing returns early here, so a low cap does
 * not prevent a long wait -- it just forces wait(60) ten times to sleep ten
 * minutes, spending ten of the turn's max_tool_rounds on sleeping. That budget
 * is for work. A runaway is bounded by max_tool_rounds anyway, and /stop
 * cancels a wait in flight, so the ceiling only needs to stop an absurd value.
 */
export const MAX_WAIT_SECONDS = 900;

/**
 * A plain timed pause.
 *
 * Forge already had a way to wait for a *process* -- exec_command with
 * background plus monitor_execution -- but nothing that produces a delay on
 * its own; that wait resolves the instant the process exits. Asked to ping on
 * an interval, the agent went looking for a sleep binary and burned two rounds
 * on it: `powershell -Command Start-Sleep` is banned, and Windows `timeout`
 * needs console stdin it never gets under `shell: false`.
 *
 * In-process rather than a spawned sleep, which is what makes it dependable:
 * no shell, no binary that might be absent, and it honours the turn's abort
 * signal so /stop does not leave a turn parked on a timer.
 */
export function makeWaitTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'wait',
        description:
          'Pause before your next step, built in (no shell needed): to space work ' +
          'out, back off a rate limit, or let a server or watcher you just started ' +
          `catch up. Maximum ${MAX_WAIT_SECONDS} seconds per call; prefer one wait of ` +
          'the length you need over several short ones. To wait for a background ' +
          'command, use monitor_execution instead. Each return reports the local ' +
          'wall-clock time: time an interval against that clock, not by counting ' +
          `waits -- an hour is four calls of ${MAX_WAIT_SECONDS}s, not one. ` +
          'Use notify_on_exit with a background command to hear when it finishes. ' +
          'Ends early when a new message arrives.',
        parameters: {
          type: 'object',
          properties: {
            seconds: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_WAIT_SECONDS,
              description: `Whole seconds to pause, 1 to ${MAX_WAIT_SECONDS}.`,
            },
          },
          required: ['seconds'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args, context) => {
      const seconds = args['seconds'] as number;
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_WAIT_SECONDS) {
        throw new Error(`wait: seconds must be a whole number from 1 to ${MAX_WAIT_SECONDS}.`);
      }
      const signal = context?.abortSignal;
      const startedAt = Date.now();
      const outcome = await new Promise<'timer' | 'abort' | 'message'>((resolve) => {
        let settled = false;
        let unsubscribe = (): void => {};
        const finish = (reason: 'timer' | 'abort' | 'message'): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          unsubscribe();
          resolve(reason);
        };
        const onAbort = (): void => finish('abort');
        const timer = setTimeout(() => finish('timer'), seconds * 1000);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (context?.tellArrived && context.conversationId) {
          unsubscribe = context.tellArrived(() => finish('message'));
          if (settled) unsubscribe();
        }
        if (signal?.aborted) finish('abort');
      });
      // Measured, not requested -- the same rule monitor_execution follows. A
      // cancelled wait that reported the full duration would have the model
      // believe time passed that never did.
      const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
      // The clock, not just the duration. A run of `Waited 900s.` gives no
      // position in time, so the only way to know how long a chain of waits has
      // covered is to count them -- and a miscount is invisible from inside.
      // Safe here in a way it is not in the system prompt: a tool result is
      // appended past everything cached, so a value that ticks costs nothing.
      const clock = `Local time is now ${localTimeOfDay()}.`;
      if (outcome === 'abort') {
        return `Wait cancelled after ${elapsedSeconds}s of the ${seconds}s requested. ${clock} The turn is stopping -- do not start further work.`;
      }
      if (outcome === 'message') {
        return `Wait ended after ${elapsedSeconds}s of the ${seconds}s requested because a new message arrived. ${clock}`;
      }
      return `Waited ${elapsedSeconds}s. ${clock}`;
    },
  };
}
