/**
 * Read-only git inspection tools: status, log, diff, blame, show.
 *
 * Split from the mutating tools in `gitTools.ts` — these never change the
 * repository, so they carry no confirmation weight.
 */

import * as child_process from 'child_process';
import type { RegisteredTool } from './ToolRegistry';
import {
  getRepo,
  gitCwd,
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

export function makeGitStatusTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'git_status',
        description: 'Show working tree and index status (modified, added, deleted files).',
        parameters: {
          type: 'object',
          properties: { cwd: cwdParameter },
          required: [],
          additionalProperties: false,
        },
      },
    },
    permission: 'git-read',
    handler: async (args) => {
      const repo = getRepo(args['cwd'] as string | undefined);
      const lines: string[] = [];

      for (const change of await readLiveGitStatus(repo)) {
        if (change.index !== ' ' && change.index !== '?') {
          lines.push(`${change.index} ${change.path} [staged]`);
        }
        if (change.workingTree !== ' ' && change.workingTree !== '?') {
          lines.push(`${change.workingTree} ${change.path}`);
        }
        if (change.index === '?' && change.workingTree === '?') lines.push(`? ${change.path}`);
      }

      return lines.length ? lines.join('\n') : 'No changes.';
    },
  };
}

// ── git_log ────────────────────────────────────────────────────────────────────

export function makeGitLogTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'git_log',
        description: 'Show recent commit log.',
        parameters: {
          type: 'object',
          properties: {
            max_entries: { type: 'integer', description: 'Max commits to return. Default 20.' },
            branch: { type: 'string', description: 'Branch or ref to log. Optional.' },
            cwd: cwdParameter,
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    permission: 'git-read',
    handler: async (args) => {
      const repo = getRepo(args['cwd'] as string | undefined);
      const maxEntries = (args['max_entries'] as number | undefined) ?? 20;
      const ref = args['branch'] as string | undefined;

      const commits = await withGitError('git_log', repo, () =>
        repo.log({ maxEntries, ...(ref ? { ref } : {}) }),
      );
      if (!commits.length) return 'No commits.';

      return commits
        .map((c) => {
          const shortHash = c.hash.slice(0, 7);
          const date =
            c.commitDate instanceof Date
              ? c.commitDate.toISOString().slice(0, 10)
              : String(c.commitDate);
          return `${shortHash} — ${c.message.split('\n')[0]} (${c.authorName}, ${date})`;
        })
        .join('\n');
    },
  };
}

// ── git_diff ───────────────────────────────────────────────────────────────────

export function makeGitDiffTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'git_diff',
        description: 'Show diff of working tree or staged changes.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Limit diff to this file path. Optional.' },
            staged: { type: 'boolean', description: 'If true, show staged diff. Default false.' },
            cwd: cwdParameter,
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    permission: 'git-read',
    handler: async (args) => {
      const cwd = args['cwd'] as string | undefined;
      const staged = args['staged'] === true;

      // vscode.git diff does not support per-file filtering; fall back to spawn for that case
      const filePath = args['path'] as string | undefined;
      const repo = getRepo(filePath ?? cwd);
      if (filePath) {
        const resolved = resolveFilePath(filePath);
        const spawnArgs = staged ? ['diff', '--staged', '--', resolved] : ['diff', '--', resolved];
        const result = child_process.spawnSync('git', spawnArgs, {
          cwd: gitCwd(filePath ?? cwd),
          encoding: 'utf8',
        });
        return result.stdout || result.stderr || '(no diff)';
      }

      const diff = await runGit(repo, ['diff', ...(staged ? ['--staged'] : [])]);
      return diff || '(no diff)';
    },
  };
}

// ── git_blame ──────────────────────────────────────────────────────────────────

export function makeGitBlameTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'git_blame',
        description: 'Show git blame for a file (line-porcelain format).',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (absolute or workspace-relative).' },
            cwd: cwdParameter,
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    permission: 'git-read',
    handler: async (args) => {
      const filePath = resolveFilePath(args['path'] as string);
      const result = child_process.spawnSync('git', ['blame', '--line-porcelain', filePath], {
        cwd: gitCwd((args['path'] as string) ?? (args['cwd'] as string | undefined)),
        encoding: 'utf8',
      });
      if (result.error) throw new Error(`git_blame: ${result.error.message}`);
      return result.stdout || result.stderr || '(no output)';
    },
  };
}

// ── git_show ───────────────────────────────────────────────────────────────────

export function makeGitShowTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'git_show',
        description:
          'Show a commit or object (git show <ref>). The ref accepts the <ref>:<path> form, ' +
          'so "HEAD~1:src/app.ts" prints that file as it was in the previous commit — the way ' +
          'to read a past version of a file without checking anything out.',
        parameters: {
          type: 'object',
          properties: {
            ref: {
              type: 'string',
              description:
                'Commit hash, tag, or ref to show. Append :<path> to show one file at that ' +
                'ref, e.g. "HEAD~1:src/app.ts" or "main:package.json".',
            },
            cwd: cwdParameter,
          },
          required: ['ref'],
          additionalProperties: false,
        },
      },
    },
    permission: 'git-read',
    handler: async (args) => {
      const ref = args['ref'] as string;
      const result = child_process.spawnSync('git', ['show', ref], {
        cwd: gitCwd(args['cwd'] as string | undefined),
        encoding: 'utf8',
      });
      if (result.error) throw new Error(`git_show: ${result.error.message}`);
      return result.stdout || result.stderr || '(no output)';
    },
  };
}

// ── create_branch ──────────────────────────────────────────────────────────────
