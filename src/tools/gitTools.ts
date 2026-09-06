/**
 * Git tools that change the repository: branch, checkout, stage, commit.
 *
 * Split from the read-only tools in `gitReadTools.ts` — every tool here is
 * confirmation-gated, and keeping them together makes that boundary visible.
 */

import type { RegisteredTool } from './ToolRegistry';
import { getRepo, getRepoForPaths, readLiveGitStatus, repoRelative, runGit } from './gitRepo';

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
      const repo = await getRepo(args['cwd'] as string | undefined);
      const name = validateBranchName('create_branch', args['name'] as string);
      const from = args['from'] as string | undefined;
      if (from !== undefined) validateStartPoint(from);
      // `-b` makes <name> a branch by definition, and the trailing `--` with no
      // pathspec after it stops <from> being read as a file to restore.
      await runGit(repo, ['checkout', '-b', name, ...(from ? [from] : []), '--']);
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
      const repo = await getRepo(args['cwd'] as string | undefined);
      const name = validateBranchName('switch_branch', args['name'] as string);
      // The trailing `--` with nothing after it forces <name> to be read as a
      // revision. Without it, `git checkout <name>` restores a *file* of that
      // name from the index if one exists — silently discarding the user's
      // edits instead of switching branch.
      await runGit(repo, ['checkout', name, '--']);
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
      const repo = await getRepoForPaths(requestedPaths);
      const relativePaths = requestedPaths.map((filePath) => repoRelative(repo, filePath));
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
      const repo = await getRepo(args['cwd'] as string | undefined);
      const message = args['message'] as string;
      const staged = (await readLiveGitStatus(repo)).some(
        (entry) => entry.index !== ' ' && entry.index !== '?',
      );
      if (!staged) {
        throw new Error(
          `git commit failed in repository "${repo.root}": nothing is staged. ` +
            'Call stage with the paths to commit first, or git_status to see what changed.',
        );
      }
      await runGit(repo, ['commit', '-m', message]);
      return `Committed: ${message}`;
    },
  };
}

/**
 * Reject branch names git would refuse or reinterpret.
 *
 * Two failures this guards against: a name beginning with `-` reaching argv as
 * an option, and a name carrying a newline or NUL, which cannot be a ref and
 * would corrupt any later parsing. Everything subtler is left to git's own
 * `check-ref-format` rules, whose error message is clearer than a re-derived
 * one would be.
 */
function validateBranchName(tool: string, name: string): string {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error(`${tool}: branch name must be a non-empty string`);
  }
  if (name.startsWith('-')) {
    throw new Error(`${tool}: branch name "${name}" is not valid (it looks like an option)`);
  }
  if (hasControlCharacter(name)) {
    throw new Error(`${tool}: branch name must not contain control characters`);
  }
  return name;
}

/** Checked by code point rather than by regex: a control character in a regex
 *  literal is itself an eslint error, and the intent is clearer this way. */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function validateStartPoint(from: string): void {
  if (from.startsWith('-')) {
    throw new Error(`create_branch: start point "${from}" is not valid (it looks like an option)`);
  }
  if (from.trim() === '' || hasControlCharacter(from)) {
    throw new Error(
      'create_branch: start point must be a non-empty ref without control characters',
    );
  }
}

function normalizeGitPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
