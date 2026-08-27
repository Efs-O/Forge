import type { RegisteredTool } from './ToolRegistry';
import { MAX_OUTPUT_CHARS, parseExecOutputOptions, stripAnsi } from './execHelpers';
import {
  backgroundExecutionManager,
  MAX_BACKGROUND_OUTPUT_CHARS,
  type BackgroundExecutionObservation,
} from './BackgroundExecutionManager';

/** Default wait for a fresh monitor call, and the value backoff resets to. */
export const DEFAULT_MONITOR_WAIT_MS = 10_000;
/** Schema ceiling for a single wait, and therefore the backoff ceiling. */
export const MAX_MONITOR_WAIT_MS = 60_000;

export function makeMonitorExecutionTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'monitor_execution',
        description:
          'Wait for a background exec_command to finish or until wait_ms elapses, then return new output and status. Output is capped per call: keep calling with the returned next_stdout_cursor / next_stderr_cursor while stdout_more_available is true. Only a bounded tail of a noisy job is retained — if stdout_dropped_chars appears, that much output is gone for good and stdout_note says what to do. waited_ms is the time actually waited; ran_for_ms is the process runtime. Always pass the returned suggested_next_wait_ms as your next wait_ms: a job that prints nothing is not necessarily stuck, and re-polling it every 10s burns the tool-round budget of the turn before a long job can finish. If output stays empty while status is running, the job is silent — progress bars redraw with a carriage return and never reach a pipe — so stop watching stdout and watch the artifact instead: poll the SIZE of the file the job is writing. Downloaders and archivers write to a temporary or partial file (.part, .incomplete, .tmp, .download) beside or BELOW the destination, not to the final path, so list the destination recursively before concluding nothing is happening.',
        parameters: {
          type: 'object',
          properties: {
            execution_id: {
              type: 'string',
              description: 'ID returned by exec_command with background=true.',
            },
            wait_ms: {
              type: 'integer',
              minimum: 0,
              maximum: 60000,
              description:
                'Maximum time to wait for completion, in milliseconds. Default 10000. Pass the suggested_next_wait_ms from the previous call rather than re-sending the default.',
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
              maximum: MAX_OUTPUT_CHARS,
              description: 'Maximum new characters per returned stream. Default 10000.',
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
      const waitMs = args['wait_ms'] === undefined ? 10_000 : (args['wait_ms'] as number);
      if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 60_000) {
        throw new Error('monitor_execution: wait_ms must be an integer from 0 to 60000.');
      }
      const outputOptions = parseExecOutputOptions(args);
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
      return formatBackgroundObservation(
        observation,
        Date.now() - startedWaitingAt,
        outputOptions,
        waitMs,
      );
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
              description: 'ID returned by exec_command with background=true.',
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
      const observation = await backgroundExecutionManager.stop(args['execution_id'] as string);
      return formatBackgroundObservation(observation, 0, {});
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
          'List every background execution started this session, with its id and status. Use this to recover an execution_id you no longer have.',
        parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },
    },
    permission: 'headless',
    autoApprove: true,
    handler: async () => {
      const executions = backgroundExecutionManager.list();
      return JSON.stringify({
        count: executions.length,
        executions: executions.map((execution) => ({
          execution_id: execution.id,
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

export function formatBackgroundObservation(
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

function splitLines(text: string): string[] {
  return text.endsWith('\n') ? text.slice(0, -1).split(/\r?\n/u) : text.split(/\r?\n/u);
}
