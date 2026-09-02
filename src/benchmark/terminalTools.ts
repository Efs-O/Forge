import type { ToolHandlerContext, ToolRegistry, RegisteredTool } from '../tools/ToolRegistry';
import { runProcess } from './process';

const MAX_RESULT_CHARS = 12_000;

function bounded(text: string): string {
  return text.length <= MAX_RESULT_CHARS
    ? text
    : `${text.slice(0, MAX_RESULT_CHARS)}\n[output truncated]`;
}

function terminalTool(name: string, description: string, root: string): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name,
        description,
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            timeout_seconds: { type: 'integer', minimum: 1, maximum: 120 },
          },
          required: ['command'],
          additionalProperties: false,
        },
      },
    },
    permission: 'terminal',
    handler: async (args: Record<string, unknown>, context?: ToolHandlerContext) => {
      const command = args.command;
      if (typeof command !== 'string' || command.length === 0)
        throw new Error('command must be a non-empty string.');
      const seconds =
        typeof args.timeout_seconds === 'number'
          ? Math.min(120, Math.max(1, args.timeout_seconds))
          : 120;
      const executable = process.platform === 'win32' ? 'cmd.exe' : 'sh';
      const argv = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command];
      const result = await runProcess(executable, argv, {
        cwd: root,
        timeoutMs: seconds * 1000,
        ...(context?.abortSignal ? { signal: context.abortSignal } : {}),
      });
      const status = result.timedOut ? 'timed out' : `exit ${result.code ?? '?'}`;
      return bounded(
        `${status}\n${result.stdout}${result.stderr ? `\nSTDERR:\n${result.stderr}` : ''}`,
      );
    },
  };
}

export function registerBenchmarkTerminalTools(registry: ToolRegistry, root: string): void {
  registry.register(
    terminalTool(
      'run_terminal',
      'Run a bounded terminal command in the benchmark workspace.',
      root,
    ),
  );
  registry.register(
    terminalTool('run_tests', 'Run the repository test command in the benchmark workspace.', root),
  );
}
