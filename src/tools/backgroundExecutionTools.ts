import type { RegisteredTool } from './ToolRegistry';
import { MAX_OUTPUT_CHARS, parseExecOutputOptions, stripAnsi } from './execHelpers';
import {
  backgroundExecutionManager,
  type BackgroundExecutionObservation,
} from './BackgroundExecutionManager';

export function makeMonitorExecutionTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'monitor_execution',
        description:
          'Wait for a background exec_command to finish or until wait_ms elapses, then return new output and status. Call again with the returned next_stdout_cursor / next_stderr_cursor to read the next chunk — output is capped per call, so a noisy job needs several calls to read in full. waited_ms is the time actually waited and ran_for_ms is the process runtime.',
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
              description: 'Maximum time to wait for completion, in milliseconds. Default 10000.',
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
      return formatBackgroundObservation(observation, Date.now() - startedWaitingAt, outputOptions);
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

export function formatBackgroundObservation(
  observation: BackgroundExecutionObservation,
  waitedMs: number,
  outputOptions: ReturnType<typeof parseExecOutputOptions>,
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
    result['stdout_truncated'] = stdout.truncated || observation.stdoutTruncated;
  }
  if (stream !== 'stdout') {
    result['stderr'] = stderr.text;
    result['stderr_truncated'] = stderr.truncated || observation.stderrTruncated;
  }
  if (observation.error !== undefined) result['error'] = observation.error;
  return JSON.stringify(result);
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
