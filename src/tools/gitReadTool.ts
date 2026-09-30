import type { RegisteredTool } from './ToolRegistry';
import {
  makeGitBlameTool,
  makeGitDiffTool,
  makeGitLogTool,
  makeGitShowTool,
  makeGitStatusTool,
} from './gitReadTools';

type Operation = 'status' | 'log' | 'diff' | 'blame' | 'show';

const handlers: Record<Operation, RegisteredTool['handler']> = {
  status: makeGitStatusTool().handler,
  log: makeGitLogTool().handler,
  diff: makeGitDiffTool().handler,
  blame: makeGitBlameTool().handler,
  show: makeGitShowTool().handler,
};

function requireParams(operation: Operation, args: Record<string, unknown>): void {
  const needed = operation === 'blame' ? ['path'] : operation === 'show' ? ['ref'] : [];
  const missing = needed.filter((key) => args[key] === undefined || args[key] === null);
  if (missing.length)
    throw new Error(`git_read operation "${operation}" needs ${missing.join(', ')}`);
}

export function makeGitReadTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'git_read',
        description: [
          'Run one read-only git operation.',
          'status: Show working tree and index status (modified, added, deleted files). (needs: cwd?)',
          'log: Show recent commit log. (needs: cwd?, max_entries?, branch?)',
          'diff: Show diff of working tree or staged changes. (needs: cwd?, path?, staged?)',
          'blame: Show git blame for a file (line-porcelain format). (needs: cwd?, path)',
          'show: Show a commit or object (git show <ref>). The ref accepts the <ref>:<path> form, so "HEAD~1:src/app.ts" prints that file as it was in the previous commit — the way to read a past version of a file without checking anything out. (needs: cwd?, ref)',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            operation: {
              type: 'string',
              enum: ['status', 'log', 'diff', 'blame', 'show'],
              description: 'Which read-only git operation to run.',
            },
            cwd: {
              type: 'string',
              description:
                'Workspace-relative directory or file used to select the repository. Required when multiple repositories are open. cwd selects the repository; file paths select the containing repository. Relative paths resolve against the first workspace folder; the repo you are working in may be nested inside it.',
            },
            ref: {
              type: 'string',
              description:
                'Commit hash, tag, or ref to show. Append :<path> to show one file at that ref, e.g. "HEAD~1:src/app.ts" or "main:package.json".',
            },
            path: {
              type: 'string',
              description:
                'blame: File path (absolute or workspace-relative). diff: Limit diff to this file path. Optional.',
            },
            max_entries: { type: 'integer', description: 'Max commits to return. Default 20.' },
            branch: { type: 'string', description: 'Branch or ref to log. Optional.' },
            staged: { type: 'boolean', description: 'If true, show staged diff. Default false.' },
          },
          required: ['operation'],
          additionalProperties: false,
        },
      },
    },
    permission: 'git-read',
    handler: async (args, context) => {
      const operation = args['operation'] as Operation;
      requireParams(operation, args);
      return handlers[operation](args, context);
    },
  };
}
