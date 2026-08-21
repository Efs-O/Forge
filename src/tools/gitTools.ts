/**
 * Git tools that change the repository: branch, checkout, stage, commit.
 *
 * Split from the read-only tools in `gitReadTools.ts` — every tool here is
 * confirmation-gated, and keeping them together makes that boundary visible.
 */

import * as path from 'path';
import type { RegisteredTool } from './ToolRegistry';
import {
  getRepo,
  getRepoForPaths,
  readLiveGitStatus,
  resolveFilePath,
  runGit,
  withGitError,
} from './gitRepo';

const cwdParameter = {
  type: 'string',
  description:
    'Workspace-relative directory or file used to select the repository. Required when multiple repositories are open.',
} as const;

export function makeCreateBranchTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'create_branch',
        description: 'Create (and check out) a new git branch.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'New branch name.' },
            from: { type: 'string', description: 'Starting ref (branch, hash). Optional.' },
            cwd: cwdParameter,
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
    },
    permission: 'git-write',
    handler: async (args) => {
      const repo = getRepo(args['cwd'] as string | undefined);
      const name = args['name'] as string;
      const from = args['from'] as string | undefined;
      await withGitError('git_create_branch', repo, () => repo.createBranch(name, true, from));
      return `Branch created: ${name}`;
    },
  };
}

// ── switch_branch ──────────────────────────────────────────────────────────────

export function makeSwitchBranchTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'switch_branch',
        description: 'Check out an existing git branch.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Branch name to check out.' },
            cwd: cwdParameter,
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
    },
    permission: 'git-write',
    handler: async (args) => {
      const repo = getRepo(args['cwd'] as string | undefined);
      const name = args['name'] as string;
      await withGitError('git_switch_branch', repo, () => repo.checkout(name));
      return `Switched to ${name}`;
    },
  };
}

// ── stage ──────────────────────────────────────────────────────────────────────

export function makeStageTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'stage',
        description:
          'Stage one or more files for commit. All paths must belong to the same repository; the repository is inferred from the paths.',
        parameters: {
          type: 'object',
          properties: {
            paths: {
              type: 'array',
              items: { type: 'string' },
              description: 'File paths to stage (absolute or workspace-relative).',
            },
          },
          required: ['paths'],
          additionalProperties: false,
        },
      },
    },
    permission: 'git-write',
    handler: async (args) => {
      const requestedPaths = args['paths'] as string[];
      const paths = requestedPaths.map(resolveFilePath);
      const repo = getRepoForPaths(requestedPaths);
      const root = repo.rootUri?.fsPath;
      if (!root) throw new Error('git_stage: selected repository has no root path');
      const relativePaths = paths.map((filePath) => path.relative(root, filePath));
      await runGit(repo, ['add', '--', ...relativePaths]);

      const requested = new Set(relativePaths.map(normalizeGitPath));
      const staged = (await readLiveGitStatus(repo)).filter(
        (entry) =>
          entry.index !== ' ' &&
          (requested.has(normalizeGitPath(entry.path)) ||
            (entry.originalPath !== undefined &&
              requested.has(normalizeGitPath(entry.originalPath)))),
      );
      if (!staged.length) return `No changes staged: ${requestedPaths.join(', ')}`;
      return `Staged: ${staged.map((entry) => entry.path).join(', ')}`;
    },
  };
}

// ── commit ─────────────────────────────────────────────────────────────────────

export function makeCommitTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'commit',
        description: 'Create a git commit with the given message.',
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'Commit message.' },
            cwd: cwdParameter,
          },
          required: ['message'],
          additionalProperties: false,
        },
      },
    },
    permission: 'git-write',
    handler: async (args) => {
      const repo = getRepo(args['cwd'] as string | undefined);
      const message = args['message'] as string;
      const staged = (await readLiveGitStatus(repo)).some(
        (entry) => entry.index !== ' ' && entry.index !== '?',
      );
      if (!staged) {
        const root = repo.rootUri?.fsPath ?? '(repository root unavailable)';
        throw new Error(`git commit failed in repository "${root}": No staged changes to commit.`);
      }
      await runGit(repo, ['commit', '-m', message]);
      return `Committed: ${message}`;
    },
  };
}

function normalizeGitPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
