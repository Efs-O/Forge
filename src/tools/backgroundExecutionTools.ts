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
          'Wait for a background exec_command to finish or until wait_ms elapses, then return new output and status. Call again with the returned cursors to continue monitoring.',
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
      const observation = await backgroundExecutionManager.observe(
        args['execution_id'] as string,
        waitMs,
        (args['stdout_cursor'] as number | undefined) ?? 0,
        (args['stderr_cursor'] as number | undefined) ?? 0,
        context?.abortSignal,
      );
      return formatBackgroundObservation(observation, waitMs, outputOptions);
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
          started_at: new Date(execution.startedAt).toISOString(),
          finished_at:
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
  const stdout = shapeBackgroundOutput(observation.stdout, outputOptions);
  const stderr = shapeBackgroundOutput(observation.stderr, outputOptions);
  const result: Record<string, unknown> = {
    execution_id: observation.id,
    status: observation.status,
    exit_code: observation.exitCode,
    waited_ms: waitedMs,
    next_stdout_cursor: observation.nextStdoutCursor,
    next_stderr_cursor: observation.nextStderrCursor,
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

function shapeBackgroundOutput(
  text: string,
  options: ReturnType<typeof parseExecOutputOptions>,
): { text: string; truncated: boolean } {
  const normalized = stripAnsi(text);
  const lines = normalized.endsWith('\n')
    ? normalized.slice(0, -1).split(/\r?\n/u)
    : normalized.split(/\r?\n/u);
  const selected =
    options.headLines !== undefined
      ? lines.slice(0, options.headLines)
      : options.tailLines !== undefined
        ? lines.slice(-options.tailLines)
        : lines;
  const shaped = selected.join('\n');
  const limit = options.maxChars ?? MAX_OUTPUT_CHARS;
  const output = options.tailLines !== undefined ? shaped.slice(-limit) : shaped.slice(0, limit);
  return { text: output, truncated: shaped.length > limit || selected.length < lines.length };
}
