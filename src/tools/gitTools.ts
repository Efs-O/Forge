import * as child_process from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';

// ── Git API bootstrap ─────────────────────────────────────────────────────────
interface GitRepository {
  state: {
    workingTreeChanges: Array<{ uri: vscode.Uri; status: number }>;
    indexChanges: Array<{ uri: vscode.Uri; status: number }>;
  };
  log(opts: {
    maxEntries: number;
    ref?: string;
  }): Promise<Array<{ hash: string; message: string; authorName: string; commitDate: Date }>>;
  diff(staged: boolean): Promise<string>;
  show(ref: string): Promise<string>;
  createBranch(name: string, checkout: boolean, ref?: string): Promise<void>;
  checkout(branch: string): Promise<void>;
  add(paths: string[]): Promise<void>;
  commit(message: string): Promise<void>;
}

function getRepo(): GitRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- vscode.git API is untyped
  const gitExt = vscode.extensions.getExtension<any>('vscode.git');
  const git = gitExt?.exports?.getAPI(1);
  const repo: GitRepository | undefined = git?.repositories?.[0];
  if (!repo) throw new Error('git_*: no git repository found in workspace');
  return repo;
}

function workspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) throw new Error('No workspace folder open');
  return folders[0].uri.fsPath;
}

function resolveFilePath(p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.join(workspaceRoot(), p);
}

// Status code → letter (subset of git status codes used by vscode.git)
function statusLetter(s: number): string {
  if (s === 1) return 'M'; // Modified
  if (s === 2) return 'A'; // Added
  if (s === 3) return 'D'; // Deleted
  if (s === 4) return 'R'; // Renamed
  if (s === 5) return 'C'; // Copied
  if (s === 6) return 'U'; // Unmerged
  return '?';
}

// ── git_status ─────────────────────────────────────────────────────────────────

export function makeGitStatusTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'git_status',
        description: 'Show working tree and index status (modified, added, deleted files).',
        parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },
    },
    permission: 'git-read',
    handler: async () => {
      const repo = getRepo();
      const root = workspaceRoot();
      const lines: string[] = [];

      for (const change of repo.state.indexChanges) {
        lines.push(
          `${statusLetter(change.status)} ${path.relative(root, change.uri.fsPath)} [staged]`,
        );
      }
      for (const change of repo.state.workingTreeChanges) {
        lines.push(`${statusLetter(change.status)} ${path.relative(root, change.uri.fsPath)}`);
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
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    permission: 'git-read',
    handler: async (args) => {
      const repo = getRepo();
      const maxEntries = (args['max_entries'] as number | undefined) ?? 20;
      const ref = args['branch'] as string | undefined;

      const commits = await repo.log({ maxEntries, ...(ref ? { ref } : {}) });
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
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    permission: 'git-read',
    handler: async (args) => {
      const repo = getRepo();
      const staged = args['staged'] === true;

      // vscode.git diff does not support per-file filtering; fall back to spawn for that case
      const filePath = args['path'] as string | undefined;
      if (filePath) {
        const resolved = resolveFilePath(filePath);
        const spawnArgs = staged ? ['diff', '--staged', '--', resolved] : ['diff', '--', resolved];
        const result = child_process.spawnSync('git', spawnArgs, {
          cwd: workspaceRoot(),
          encoding: 'utf8',
        });
        return result.stdout || result.stderr || '(no diff)';
      }

      const diff = await repo.diff(staged);
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
        cwd: workspaceRoot(),
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
        description: 'Show a commit or object (git show <ref>).',
        parameters: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'Commit hash, tag, or ref to show.' },
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
        cwd: workspaceRoot(),
        encoding: 'utf8',
      });
      if (result.error) throw new Error(`git_show: ${result.error.message}`);
      return result.stdout || result.stderr || '(no output)';
    },
  };
}

// ── create_branch ──────────────────────────────────────────────────────────────

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
