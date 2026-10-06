import type { ToolHandlerContext, ToolRegistry, RegisteredTool } from '../tools/ToolRegistry';
import * as path from 'node:path';
import { runProcess } from './process';

const MAX_RESULT_CHARS = 12_000;

function bounded(text: string): string {
  return text.length <= MAX_RESULT_CHARS
    ? text
    : `${text.slice(0, MAX_RESULT_CHARS)}\n[output truncated]`;
}

function terminalTool(
  name: string,
  description: string,
  root: string,
  permission: 'terminal' | 'headless' = 'terminal',
): RegisteredTool {
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
            cwd: { type: 'string' },
            timeout_ms: { type: 'integer', minimum: 1_000, maximum: 120_000 },
          },
          required: ['command'],
          additionalProperties: false,
        },
      },
    },
    permission,
    handler: async (args: Record<string, unknown>, context?: ToolHandlerContext) => {
      const command = args.command;
      if (typeof command !== 'string' || command.length === 0)
        throw new Error('command must be a non-empty string.');
      const timeoutMs =
        typeof args.timeout_ms === 'number'
          ? Math.min(120_000, Math.max(1_000, args.timeout_ms))
          : 120_000;
      const executable = process.platform === 'win32' ? 'cmd.exe' : 'sh';
      const argv = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command];
      const cwd = typeof args.cwd === 'string' ? path.resolve(root, args.cwd) : root;
      const relative = path.relative(root, cwd);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`cwd escapes the benchmark workspace: ${args.cwd}`);
      }
      const result = await runProcess(executable, argv, {
        cwd,
        timeoutMs,
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
    terminalTool('shell', 'Run a bounded command in the benchmark workspace.', root, 'headless'),
  );
  registry.register(
    terminalTool('run_tests', 'Run the repository test command in the benchmark workspace.', root),
  );
}
