/**
 * Git tools that change the repository: branch, checkout, stage, commit.
 *
 * Split from the read-only tools in `gitReadTools.ts` — every tool here is
 * confirmation-gated, and keeping them together makes that boundary visible.
 */

import type { RegisteredTool } from './ToolRegistry';
import { getRepo, resolveFilePath } from './gitRepo';

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
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
    },
    permission: 'git-write',
    handler: async (args) => {
      const repo = getRepo();
      const name = args['name'] as string;
      const from = args['from'] as string | undefined;
      await repo.createBranch(name, true, from);
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
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
    },
    permission: 'git-write',
    handler: async (args) => {
      const repo = getRepo();
      const name = args['name'] as string;
      await repo.checkout(name);
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
        description: 'Stage one or more files for commit.',
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
      const repo = getRepo();
      const paths = (args['paths'] as string[]).map(resolveFilePath);
      await repo.add(paths);
      return `Staged: ${(args['paths'] as string[]).join(', ')}`;
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
          },
          required: ['message'],
          additionalProperties: false,
        },
      },
    },
    permission: 'git-write',
    handler: async (args) => {
      const repo = getRepo();
      const message = args['message'] as string;
      await repo.commit(message);
      return `Committed: ${message}`;
    },
  };
}
