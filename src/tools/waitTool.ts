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
          'Pause for a number of seconds before your next step -- the equivalent of ' +
          'Start-Sleep or "timeout /t", but built in, so it needs no shell and works ' +
          'when those are unavailable. Use it to space work out over time, such as ' +
          'pinging the user on an interval, to back off before retrying something ' +
          'rate-limited, or -- while coding -- to give something you just started ' +
          'or changed time to become observable: a dev server or file watcher you ' +
          'launched in the background needs a moment before it will answer a ' +
          'request, and a file you just wrote may need one before an index, a ' +
          'watcher, or another process reflects it. Waiting once beats retrying a ' +
          'check that cannot succeed yet. Maximum ' +
          `${MAX_WAIT_SECONDS} seconds (${MAX_WAIT_SECONDS / 60} minutes) per call; ` +
          'prefer one wait of the length you need over several short ones, which ' +
          'spend your tool-call budget on sleeping. To wait for a specific ' +
          'background command rather than a fixed delay, use monitor_execution ' +
          'instead -- it returns as soon as that command finishes, which is quicker ' +
          'and more precise than guessing a duration here. Each return reports the ' +
          'local wall-clock time it finished at: for a task on an interval, work out ' +
          'the next deadline from that clock rather than from how many waits you have ' +
          'called, and chain waits until the clock reaches it -- an hour is four calls ' +
          `of ${MAX_WAIT_SECONDS}s, not one. Use notify_on_exit to be told when a background job exits. Ends early when a message arrives.`,
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
