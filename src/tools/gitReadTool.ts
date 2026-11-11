import type { RegisteredTool } from './ToolRegistry';
import type { ForgeConfig } from '../config/types';
import {
  secretApprovalKeyFor,
  secretCardReason,
  secretDeclineHint,
  secretPatternForArgument,
  secretPatternForTaint,
} from './secretPaths';
import { markConversationReadSecret } from './exfilTaint';
import { resolveWorkspacePath } from '../util/WorkspacePaths';
import { capShellOutput } from './shellOutput';
import { DEFAULT_TOOL_OUTPUT_LIMITS } from './toolOutputLimits';
import { resolveGitRequest, runGit } from './gitRepo';
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

async function statusBranchLine(args: Record<string, unknown>): Promise<string> {
  const cwd = typeof args['cwd'] === 'string' ? args['cwd'] : undefined;
  const { repo } = await resolveGitRequest('git_read', cwd);
  const header = (await runGit(repo, ['status', '--porcelain=v1', '--branch'])).split(
    /\r?\n/u,
    1,
  )[0];
  if (!header?.startsWith('## ')) {
    throw new Error('git_read status failed: Git returned no porcelain branch header');
  }

  const branch = header.slice(3);
  if (branch.startsWith('HEAD ')) {
    const shortSha = (await runGit(repo, ['rev-parse', '--short', 'HEAD'])).trim();
    if (!/^[0-9a-f]+$/iu.test(shortSha)) {
      throw new Error('git_read status failed: Git returned no short HEAD hash');
    }
    return `HEAD detached at ${shortSha}.`;
  }

  const unbornPrefix = 'No commits yet on ';
  const branchName = (
    branch.startsWith(unbornPrefix) ? branch.slice(unbornPrefix.length) : branch
  ).split('...', 1)[0];
  if (!branchName) throw new Error('git_read status failed: Git returned an empty branch name');
  return `On branch ${branchName}.`;
}

export function makeGitReadTool(
  deps: {
    getConfig?: () => ForgeConfig;
    home?: string;
    platform?: NodeJS.Platform;
  } = {},
): RegisteredTool {
  /** `git show HEAD:.env` and a diff limited to `.env` print the file's
   *  contents, so they are a read of it: the same gate as `read_file`, and
   *  `git status`/`log` name paths without printing their contents, so they
   *  stay ungated. */
  const secretPatternOf = (candidate: string): string | undefined =>
    secretPatternForArgument(candidate, deps.getConfig?.(), resolveWorkspacePath, deps);
  /** The taint question, with nothing allow-listed: the allow list may skip
   *  this call's card, never the flag that marks the chat for its next fetch. */
  const secretTaintOf = (candidate: string): string | undefined =>
    secretPatternForTaint(candidate, deps.getConfig?.(), resolveWorkspacePath, deps);
  /** The paths this call could print the contents of. `ref` accepts the
   *  `ref:path` form, and `path` limits a `diff` or a `blame`, so all three are
   *  reads of that file; `status` and `log` name paths without printing their
   *  contents, and take neither of these arguments. */
  const contentPaths = (args: Record<string, unknown>): string[] => {
    const ref = typeof args['ref'] === 'string' ? args['ref'] : '';
    const refPath = ref.includes(':') ? ref.slice(ref.indexOf(':') + 1) : '';
    return [typeof args['path'] === 'string' ? args['path'] : '', refPath].filter(
      (value) => value.length > 0,
    );
  };
  return {
    definition: {
      type: 'function',
      function: {
        name: 'git_read',
        description: [
          'Run one read-only git operation.',
          'status: Show working tree and index status (modified, added, deleted files). Includes the current branch. (needs: cwd?)',
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
                'Directory (or file) that selects the repository: absolute, or relative to the workspace root. Required when multiple repositories are open; the repo you are working in may be nested inside the workspace.',
            },
            ref: {
              type: 'string',
              description:
                'Commit hash, tag, or ref to show. Append :<path> to show one file at that ref, e.g. "HEAD~1:src/app.ts" or "main:package.json".',
            },
            path: {
              type: 'string',
              description:
                'blame: the file. diff: limits the diff to this file; optional. Absolute, or relative: with cwd, relative to cwd, and a path that already starts with cwd is read from the workspace root.',
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
    approval: (args) => {
      const candidates = contentPaths(args);
      const secretReads = candidates.filter(
        (candidate) => secretPatternOf(candidate) !== undefined,
      );
      if (secretReads.length === 0) return undefined;
      const candidate = secretReads[0]!;
      const pattern = secretPatternOf(candidate)!;
      // The same rule as `read_file`: one file is a key, two files are not, because a
      // rule for the first would leave the second printing its contents unasked.
      const approvalKey =
        secretReads.length === 1
          ? secretApprovalKeyFor(candidate, resolveWorkspacePath, deps)
          : undefined;
      return {
        detail: `${candidate}\nMatched secret path rule: ${pattern}`,
        dangerous: true,
        gateKind: 'ownerGate',
        cardReason: secretCardReason(pattern),
        declineHint: secretDeclineHint(pattern),
        ...(approvalKey ? { approvalKey } : {}),
      };
    },
    handler: async (args, context) => {
      const operation = args['operation'] as Operation;
      requireParams(operation, args);
      const result = await handlers[operation](args, context);
      if (typeof result !== 'string') return result;
      const output = operation === 'status' ? `${await statusBranchLine(args)}\n${result}` : result;
      // A whole-repo diff or show can be megabytes: keep head and tail, spill the rest.
      const capped = await capShellOutput(
        output,
        context?.conversationId ?? 'unknown',
        context?.toolCallId ?? 'unknown',
        context?.outputLimits?.shellInlineChars ?? DEFAULT_TOOL_OUTPUT_LIMITS.shellInlineChars,
      );
      // A secret printed here is a secret this chat has read, allow-listed or
      // not: `git show HEAD:.env` of a path the owner put in
      // `permissions.secret_paths_allow` gets no card, and without the flag its
      // next fetch would leave the machine as if nothing had been read.
      const secretPath = contentPaths(args)
        .map((candidate) => ({ candidate, pattern: secretTaintOf(candidate) }))
        .find((entry) => entry.pattern);
      if (secretPath)
        markConversationReadSecret(
          context?.conversationId,
          secretPath.pattern,
          secretPath.candidate,
        );
      return capped.text;
    },
  };
}
