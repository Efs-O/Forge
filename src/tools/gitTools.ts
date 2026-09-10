/**
 * Git tools that change the repository: branch, checkout, stage, commit.
 *
 * Split from the read-only tools in `gitReadTools.ts` — every tool here is
 * confirmation-gated, and keeping them together makes that boundary visible.
 */

import type { RegisteredTool } from './ToolRegistry';
import {
  getRepo,
  getRepoForPaths,
  readLiveGitStatus,
  repoRelative,
  runGit,
  type GitRepoHandle,
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
      // Naming the kind, not just the path: `Staged: CHANGES.md` read as an
      // edit when it was in fact a deletion, and the commit message written
      // from it said so.
      return `Staged: ${staged
        .map((entry) => `${entry.path} (${describeIndexState(entry.index)})`)
        .join(', ')}`;
    },
  };
}

// ── restore_file ───────────────────────────────────────────────────────────────

/**
 * The sanctioned counterpart to the denylisted `git checkout <ref> -- <path>`.
 *
 * The raw command is refused for a good reason — it overwrites uncommitted work
 * with no reflog entry — but the refusal used to offer `switch_branch` and
 * `git_show` as alternatives, neither of which can put a file back. An agent
 * that had just deleted and committed a tracked file hit that wall and had to
 * hand the problem to the user. The capability is legitimate; what it needed
 * was a gate, which being a confirmation-gated tool provides.
 */
export function makeRestoreFileTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'restore_file',
        description:
          'Restore files to their committed content from a git ref (HEAD by default), ' +
          'recreating them if they were deleted. Use this to undo an unwanted delete_file ' +
          'or edit on a tracked path. Any uncommitted changes to these paths are overwritten.',
        parameters: {
          type: 'object',
          properties: {
            paths: {
              type: 'array',
              items: { type: 'string' },
              description: 'File paths to restore (absolute or workspace-relative).',
            },
            ref: {
              type: 'string',
              description:
                'Commit, branch, or tag to restore from. Defaults to HEAD. Use HEAD~1 to ' +
                'recover a file the most recent commit deleted.',
            },
          },
          required: ['paths'],
          additionalProperties: false,
        },
      },
    },
    permission: 'write',
    mutation: { paths: (args) => args['paths'] as string[], showDiff: true },
    approval: (args) => {
      const paths = Array.isArray(args['paths']) ? (args['paths'] as string[]) : [];
      const ref = typeof args['ref'] === 'string' ? args['ref'] : 'HEAD';
      return {
        detail:
          `About to overwrite from git ${ref}:\n${paths.join('\n')}\n` +
          'Any uncommitted changes to these paths are discarded.',
      };
    },
    handler: async (args) => {
      const requestedPaths = args['paths'] as string[];
      if (!Array.isArray(requestedPaths) || requestedPaths.length === 0) {
        throw new Error('restore_file: at least one path is required');
      }
      const ref = validateRef('restore_file', (args['ref'] as string | undefined) ?? 'HEAD');
      const repo = await getRepoForPaths(requestedPaths);
      const relativePaths = requestedPaths.map((filePath) => repoRelative(repo, filePath));
      await runGit(repo, ['checkout', ref, '--', ...relativePaths]);
      return `Restored from ${ref}: ${relativePaths.join(', ')}`;
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
        description:
          'Create a git commit with the given message, or amend the previous one. ' +
          'Amending is refused once the commit has reached a remote.',
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'Commit message.' },
            amend: {
              type: 'boolean',
              description:
                'If true, replace the previous commit instead of adding one, rewriting it ' +
                'with the staged changes and this message. Default false.',
            },
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
      const amend = args['amend'] === true;
      const staged = (await readLiveGitStatus(repo)).some(
        (entry) => entry.index !== ' ' && entry.index !== '?',
      );
      // An amend with an empty index is legitimate — it rewrites the message
      // alone — so the "nothing is staged" guard applies to new commits only.
      if (!staged && !amend) {
        throw new Error(
          `git commit failed in repository "${repo.root}": nothing is staged. ` +
            'Call stage with the paths to commit first, or git_status to see what changed.',
        );
      }
      if (amend) await refuseAmendOfPublishedCommit(repo);
      await runGit(repo, ['commit', ...(amend ? ['--amend'] : []), '-m', message]);
      return `${amend ? 'Amended' : 'Committed'}: ${message}`;
    },
  };
}

/**
 * Rewriting a commit someone else may already have fetched is the user's call,
 * not the agent's — every collaborator who has it must then recover by hand.
 * A commit still only in the local branch has no such cost.
 */
async function refuseAmendOfPublishedCommit(repo: GitRepoHandle): Promise<void> {
  let remoteBranches: string;
  try {
    remoteBranches = await runGit(repo, ['branch', '-r', '--contains', 'HEAD']);
  } catch {
    // No commits yet, or no remotes configured: nothing has been published, so
    // there is nothing to protect.
    return;
  }
  const containing = remoteBranches
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!containing.length) return;
  throw new Error(
    `commit: refusing to amend — HEAD is already on ${containing.join(', ')}. ` +
      'Amending a pushed commit rewrites published history; make a new commit instead, ' +
      'or ask the user to rewrite and force-push themselves.',
  );
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
  validateRef('create_branch', from, 'start point');
}

/**
 * Reject a ref git would reinterpret as an option or that cannot be one.
 *
 * Everything subtler is left to git, whose own error names the actual problem
 * better than a re-derived check would.
 */
function validateRef(tool: string, ref: string, label = 'ref'): string {
  if (typeof ref !== 'string' || ref.trim() === '') {
    throw new Error(`${tool}: ${label} must be a non-empty ref`);
  }
  if (ref.startsWith('-')) {
    throw new Error(`${tool}: ${label} "${ref}" is not valid (it looks like an option)`);
  }
  if (hasControlCharacter(ref)) {
    throw new Error(`${tool}: ${label} must not contain control characters`);
  }
  return ref;
}

/** Porcelain v1's index column, in words. */
function describeIndexState(index: string): string {
  switch (index) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'M':
      return 'modified';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'type changed';
    default:
      return `index state "${index}"`;
  }
}

function normalizeGitPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
