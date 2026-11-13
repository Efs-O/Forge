import type { RegisteredTool } from './ToolRegistry';
import { localTimeOfDay } from '../util/localClock';
import {
  MAX_OUTPUT_CHARS,
  MAX_OUTPUT_CHARS_CEILING,
  parseExecOutputOptions,
  stripAnsi,
} from './execHelpers';
import { DEFAULT_TOOL_OUTPUT_LIMITS } from './toolOutputLimits';
import {
  backgroundExecutionManager,
  type BackgroundExecutionObservation,
} from './BackgroundExecutionManager';
import { MAX_BACKGROUND_OUTPUT_CHARS } from './backgroundOutput';

/** Default wait for a fresh monitor call, and the value backoff resets to. */
const DEFAULT_MONITOR_WAIT_MS = 10_000;
/** Schema ceiling for a single wait, and therefore the backoff ceiling. */
const MAX_MONITOR_WAIT_MS = 60_000;

/**
 * shell's `notify_on_exit` description, used by both shell variants. It has been
 * on by default for a background command since 2026-10-30, so the negative
 * cases still have to be spelled out in full: a model that expects a notice
 * which never comes waits forever, so it must know exactly when none is sent.
 * The shell rewrite once replaced this with a one-liner that dropped them
 * (U15-10).
 */
export const NOTIFY_ON_EXIT_DESCRIPTION =
  'On by default with background=true; pass false to opt out (a server you do not ' +
  'want to hear about, for example). Only a background command can notify: true ' +
  'without background=true, or with no chat, is an error. On exit, Forge posts ' +
  'status and last output into this chat, starting a new turn if idle. For a job ' +
  'you do not need now, or a watcher script that exits when what it watches ' +
  'changes: start it, tell the user, end your turn instead of polling. No notice ' +
  'if the window reloads, you stop the job, monitor_execution already saw it end, ' +
  'or the owner stopped the turn — a stopped chat is never restarted by a job ' +
  'finishing, though its jobs keep running and list_executions still shows them.';

export function makeMonitorExecutionTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'monitor_execution',
        description:
          'Wait for a background shell command and return new output plus status when this turn must see the output: a background job wakes the chat on its own when it ends, so watching one does not have to hold a turn open. Reuse the returned cursors and suggested_next_wait_ms; *_dropped_chars means that output is gone. A running job with no output may be silent: inspect its artifact, including nearby or nested .part/.tmp files, instead of polling rapidly.',
        parameters: {
          type: 'object',
          properties: {
            execution_id: {
              type: 'string',
              description: 'ID returned by shell with background=true.',
            },
            wait_ms: {
              type: 'integer',
              minimum: 0,
              maximum: 60000,
              description: 'Max wait in ms (default 10000). Reuse suggested_next_wait_ms.',
            },
            stdout_cursor: {
              type: 'integer',
              minimum: 0,
              description: 'Cursor returned as next_stdout_cursor. Default 0.',
            },
            stderr_cursor: {
              type: 'integer',
              minimum: 0,
              description: 'Cursor returned as next_stderr_cursor. Default 0.',
            },
            max_output_chars: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_OUTPUT_CHARS_CEILING,
              description:
                "Maximum new characters per returned stream. Default scales with the model's context.",
            },
            output_stream: {
              type: 'string',
              enum: ['both', 'stdout', 'stderr'],
              description: 'Which new output stream to return. Default both.',
            },
          },
          required: ['execution_id'],
          additionalProperties: false,
        },
      },
    },
    permission: 'headless',
    autoApprove: true,
    handler: async (args, context) => {
      const requestedWaitMs = args['wait_ms'] === undefined ? 10_000 : (args['wait_ms'] as number);
      if (!Number.isInteger(requestedWaitMs) || requestedWaitMs < 0) {
        throw new Error('monitor_execution: wait_ms must be a non-negative integer.');
      }
      const waitMs = Math.min(requestedWaitMs, MAX_MONITOR_WAIT_MS);
      const requested = parseExecOutputOptions(
        args,
        context?.outputLimits?.execOutputChars ?? DEFAULT_TOOL_OUTPUT_LIMITS.execOutputChars,
      );
      // Measured, not requested. The wait resolves the moment the process
      // finishes or the turn is cancelled, so echoing wait_ms back reported a
      // full-length wait for a call that returned in a fraction of it.
      const startedWaitingAt = Date.now();
      const observation = await backgroundExecutionManager.observe(
        args['execution_id'] as string,
        waitMs,
        (args['stdout_cursor'] as number | undefined) ?? 0,
        (args['stderr_cursor'] as number | undefined) ?? 0,
        context?.abortSignal,
      );
      const formatted = formatBackgroundObservation(
        observation,
        Date.now() - startedWaitingAt,
        namesOutputOptions(args) ? requested : (observation.outputOptions ?? requested),
        waitMs,
      );
      if (requestedWaitMs <= MAX_MONITOR_WAIT_MS) return formatted;
      const result = JSON.parse(formatted) as Record<string, unknown>;
      result['note'] = `wait_ms clamped to ${String(MAX_MONITOR_WAIT_MS)}`;
      return JSON.stringify(result);
    },
  };
}

export function makeStopExecutionTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'stop_execution',
        description: 'Stop a running background execution and return its final status.',
        parameters: {
          type: 'object',
          properties: {
            execution_id: {
              type: 'string',
              description: 'ID returned by shell with background=true.',
            },
          },
          required: ['execution_id'],
          additionalProperties: false,
        },
      },
    },
    permission: 'headless',
    // Stopping a job the agent itself started is less risky than starting it
    // was — gating the stop harder than the start only adds friction.
    autoApprove: true,
    handler: async (args) => {
      const id = args['execution_id'] as string;
      const observation = await backgroundExecutionManager.stop(id);
      const text = formatBackgroundObservation(observation, 0, {});
      // A job that had already ended answers with its own outcome, and that
      // outcome reads like a stop went wrong: `status: failed, exit_code: 1` is
      // how the job finished, not what this call did. Only an interruption
      // reports `terminated` with a null exit code, so say which one this is.
      if (observation.status !== 'terminated') {
        return (
          `${text}\nnote: this job had already ended on its own (exit_code: ` +
          `${observation.exitCode}); stop_execution did not interrupt it. Only an interrupted ` +
          'job reports status "terminated" with exit_code null.'
        );
      }
      return text;
    },
  };
}

export function makeListExecutionsTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'list_executions',
        description:
          'List the background executions in this VS Code window, from every chat (this_chat marks yours), with id and status. Use it to recover a lost execution_id.',
        parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },
    },
    permission: 'headless',
    autoApprove: true,
    handler: async (_args, context) => {
      const executions = backgroundExecutionManager.list();
      return JSON.stringify({
        count: executions.length,
        executions: executions.map((execution) => ({
          execution_id: execution.id,
          this_chat:
            context?.conversationId !== undefined &&
            execution.conversationId === context.conversationId,
          command: [execution.command, ...execution.args].join(' '),
          cwd: execution.cwd,
          status: execution.status,
          pid: execution.pid,
          // ISO timestamps are UTC and read as hours-wrong against the user's
          // clock, and "how long has this been running" is the actual question
          // — so answer it directly rather than making the caller subtract.
          ran_for_ms: (execution.finishedAt ?? Date.now()) - execution.startedAt,
          started_at_utc: new Date(execution.startedAt).toISOString(),
          finished_at_utc:
            execution.finishedAt === undefined
              ? null
              : new Date(execution.finishedAt).toISOString(),
          exit_code: execution.exitCode,
        })),
      });
    },
  };
}

/**
 * Next wait to suggest, given how long this call waited for nothing.
 *
 * Geometric, and deliberately stateless: the caller feeds the suggestion back
 * as `wait_ms`, so doubling the REQUESTED wait produces 10s → 20s → 40s → 60s
 * without the manager tracking a poll count per execution. Measured wait is the
 * wrong input — a cancelled turn returns early, and scaling from that would
 * suggest a shorter wait for a job that is still running.
 *
 * Why this matters more here than it looks: the agent has to stay parked inside
 * a live turn to observe a background job, so every poll spends one of the
 * turn's `max_tool_rounds`. At the 10s default a 20-minute download costs 120
 * rounds and the turn dies waiting; at the 60s ceiling it costs 20.
 */
function suggestNextWaitMs(requestedWaitMs: number, sawNewOutput: boolean): number {
  if (sawNewOutput) return DEFAULT_MONITOR_WAIT_MS;
  // A zero/short wait is a deliberate status peek, not a poll that came up
  // empty — start the ladder at the default rather than doubling nothing.
  const base = Math.max(requestedWaitMs, DEFAULT_MONITOR_WAIT_MS);
  return Math.min(base * 2, MAX_MONITOR_WAIT_MS);
}

function formatBackgroundObservation(
  observation: BackgroundExecutionObservation,
  waitedMs: number,
  outputOptions: ReturnType<typeof parseExecOutputOptions>,
  requestedWaitMs?: number,
): string {
  const stream = outputOptions.stream ?? 'both';
  const stdout = shapeBackgroundOutput(
    observation.stdout,
    outputOptions,
    observation.stdoutStart,
    observation.stdoutEnd,
  );
  const stderr = shapeBackgroundOutput(
    observation.stderr,
    outputOptions,
    observation.stderrStart,
    observation.stderrEnd,
  );
  const ranForMs = (observation.finishedAt ?? Date.now()) - observation.startedAt;
  const result: Record<string, unknown> = {
    execution_id: observation.id,
    status: observation.status,
    exit_code: observation.exitCode,
    waited_ms: waitedMs,
    ran_for_ms: ranForMs,
    // The wall clock alongside the durations. An agent parked on a long job
    // interleaves this tool with `wait`, and durations alone give it no
    // position in time to date a progress report from -- see localClock.ts.
    local_time: localTimeOfDay(),
    next_stdout_cursor: stdout.nextCursor,
    next_stderr_cursor: stderr.nextCursor,
  };
  if (stream !== 'stderr') {
    result['stdout'] = stdout.text;
    describeStream(result, 'stdout', stdout.nextCursor, observation.stdoutEnd, observation);
  }
  if (stream !== 'stdout') {
    result['stderr'] = stderr.text;
    describeStream(result, 'stderr', stderr.nextCursor, observation.stderrEnd, observation);
  }
  if (observation.error !== undefined) result['error'] = observation.error;
  if (outputOptions.maxCharsClamped) {
    result['note'] =
      `max_output_chars clamped to ${String(outputOptions.maxChars)} for this model's context.`;
  }
  if (requestedWaitMs !== undefined && observation.status === 'running') {
    const sawNewOutput =
      stdout.nextCursor > observation.stdoutStart || stderr.nextCursor > observation.stderrStart;
    const suggested = suggestNextWaitMs(requestedWaitMs, sawNewOutput);
    result['suggested_next_wait_ms'] = suggested;
    // Only once the ladder has actually left the default — saying this on every
    // poll of a chatty job is noise, and the advice only applies to a silent one.
    if (!sawNewOutput && suggested > DEFAULT_MONITOR_WAIT_MS) {
      result['silence_note'] =
        'No new output while still running. Silence is not evidence the job is stuck — many ' +
        'programs draw progress with a carriage return, which never reaches a pipe. Pass ' +
        `suggested_next_wait_ms (${String(suggested)}) as your next wait_ms, and check progress ` +
        'by listing the destination directory recursively and watching a file GROW: downloads ' +
        'and archives write to a .part / .incomplete / .tmp file below the destination, not to ' +
        'the final path.';
    }
  }
  return JSON.stringify(result);
}

/**
 * One boolean used to mean two unrelated things: "this call was capped, ask
 * again" and "these characters are gone for good". An agent reading
 * `truncated: true` could not tell which, and the one that hit it in practice
 * concluded the cursor API was broken and stopped using it. Report them
 * separately, and when output really was lost, say how much and what to do.
 */
function describeStream(
  result: Record<string, unknown>,
  name: 'stdout' | 'stderr',
  nextCursor: number,
  end: number,
  observation: BackgroundExecutionObservation,
): void {
  const oldest = name === 'stdout' ? observation.stdoutOldest : observation.stderrOldest;
  const dropped = name === 'stdout' ? observation.stdoutDropped : observation.stderrDropped;
  result[`${name}_more_available`] = nextCursor < end;
  result[`${name}_oldest_available_cursor`] = oldest;
  if (dropped > 0) {
    result[`${name}_dropped_chars`] = dropped;
    result[`${name}_note`] =
      `${String(dropped)} characters before your cursor were discarded by the ` +
      `${String(MAX_BACKGROUND_OUTPUT_CHARS)}-character retention cap and cannot be recovered; ` +
      `reading resumed at ${String(oldest)}. Redirect the command's output to a file if you need ` +
      `it from the beginning.`;
  }
}

/**
 * Shapes one stream for display AND says where the next read resumes.
 *
 * The cap is applied to the RAW text before ANSI is stripped, because the next
 * cursor has to be expressed in the same units the buffer is indexed by —
 * counting stripped characters would under-advance it and re-serve the same
 * bytes forever.
 *
 * `tail_lines` is the one case that consumes everything: the caller asked for
 * the end of the stream, so resuming mid-buffer would hand back output it has
 * already been shown.
 */
function shapeBackgroundOutput(
  text: string,
  options: ReturnType<typeof parseExecOutputOptions>,
  start: number,
  end: number,
): { text: string; truncated: boolean; nextCursor: number } {
  const limit = options.maxChars ?? MAX_OUTPUT_CHARS;

  if (options.tailLines !== undefined) {
    const normalized = stripAnsi(text);
    const lines = splitLines(normalized);
    const selected = lines.slice(-options.tailLines);
    const shaped = selected.join('\n');
    return {
      text: shaped.slice(-limit),
      truncated: shaped.length > limit || selected.length < lines.length,
      nextCursor: end,
    };
  }

  const raw =
    options.headLines !== undefined
      ? splitLines(text).slice(0, options.headLines).join('\n')
      : text;
  const consumed = raw.slice(0, limit);
  return {
    text: stripAnsi(consumed),
    truncated: consumed.length < text.length,
    nextCursor: start + consumed.length,
  };
}

/** True when a monitor call shapes its own output instead of inheriting the start's. */
function namesOutputOptions(args: Record<string, unknown>): boolean {
  return ['head_lines', 'tail_lines', 'max_output_chars', 'output_stream'].some(
    (key) => args[key] !== undefined,
  );
}

function splitLines(text: string): string[] {
  return text.endsWith('\n') ? text.slice(0, -1).split(/\r?\n/u) : text.split(/\r?\n/u);
}
