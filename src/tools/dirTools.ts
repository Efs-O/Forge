/**
 * `find_files`, plus the two things it needs: the note that explains a
 * gitignored miss, and the ripgrep crawl that lists names without reading
 * contents. `search_code` lives in `searchCodeTool.ts` — it reads contents,
 * which is why the secret-path gate belongs there and not here.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';
import { resolveRipgrep, type RipgrepResolution } from './RipgrepResolver';
import { isGlobInclude, namedExistingPath, namedPathScope, rgScopeArgs } from './searchScope';

/**
 * A glob search can skip files the workspace's `.gitignore` excludes; only an
 * exact existing path gets `--no-ignore-vcs` (see `namedExistingPath`). That is
 * how `.forge/config.yaml` — gitignored, and the file edited most — came back
 * "no matches" three times in one session for text it plainly held, and the
 * agent fell back to eight blind `read_file` pages. Say so on the miss.
 */
export function gitignoredNote(
  glob: string,
  includeIgnored = false,
  fix = 'pass an exact file or folder path, or set include_ignored: true',
): string {
  if (!isGlobInclude(glob)) return '';
  if (includeIgnored) return '';
  return ` A glob can skip gitignored files; ${fix}.`;
}

/**
 * The sentence for an `include` that named one path exactly and that path is not
 * there, so the search opened no file at all.
 *
 * Without it the answer is a bare "No matches found", which the model reads as
 * "this text is not in the tree" and stops looking — while the real fact is that
 * the folder it asked for was never opened. `namedExistingPath` already decided
 * this include was not an existing path; this says which of the two reasons it
 * was not, because they have two different fixes.
 */
export function missingIncludeNote(include: string, workspaceRoot: string): string | undefined {
  if (isGlobInclude(include) || include.startsWith('-') || include.trim() === '') return undefined;
  if (path.isAbsolute(include)) return undefined; // the scope resolver already refused it
  const resolved = path.resolve(workspaceRoot, include);
  const inside = path.relative(workspaceRoot, resolved);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
    return (
      ` The include \`${include}\` resolves outside the workspace root, so this search opened no ` +
      "file. Prefix a nested repository's directory, lead with `**/` to match at any depth, or " +
      'pass an absolute path to search outside the workspace.'
    );
  }
  try {
    fs.statSync(resolved);
    return undefined;
  } catch {
    return (
      ` The include \`${include}\` names one path exactly, and nothing at it exists under the ` +
      'workspace root, so this search opened no file. Check the spelling against the tree with ' +
      '`find_files`, or lead with `**/` to match the name at any depth.'
    );
  }
}

/**
 * Lists workspace files matching a glob, via the same ripgrep `search_code` uses.
 *
 * Previously `vscode.workspace.findFiles`, which routes through VS Code's
 * indexed search service. On this workspace that reported "no files match" for
 * paths that plainly exist and are not ignored — `threejs-game-prompt/
 * package*.json` and `threejs-game-prompt/REFACTOR_PLAN.md` among them, 16
 * failures in 42 calls — while `search_code` was returning those very paths
 * from the same root. The workspace sits on a mapped network drive, where that
 * index is unreliable. Two file-matching tools backed by two different engines
 * could disagree about what the workspace contains; now there is one engine,
 * one root, and one glob dialect.
 */
async function listWorkspaceFiles(
  pattern: string,
  maxResults: number,
  includeIgnored: boolean,
  resolution: RipgrepResolution,
  signal?: AbortSignal,
): Promise<string[]> {
  signal?.throwIfAborted();
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('No workspace folder open.');

  // `--hidden` so dot-directories (.forge, .vscode, .github) are crawled at
  // all; ignore files still filter them, which is the behaviour that keeps
  // node_modules out.
  const named = namedExistingPath(pattern, folder.uri.fsPath);
  const scope = named
    ? namedPathScope(named, folder.uri.fsPath)
    : {
        target: '.',
        glob: pattern,
        explicitPath: false,
        applyExcludes: true,
        rootDir: path.resolve(folder.uri.fsPath).replace(/\\/gu, '/'),
      };
  const scopeArgs = rgScopeArgs(scope);
  const ignoreArgs =
    includeIgnored && !scopeArgs.includes('--no-ignore-vcs') ? ['--no-ignore-vcs'] : [];
  const args = ['--files', '--hidden', ...ignoreArgs, ...scopeArgs, scope.target];

  return new Promise<string[]>((resolve, reject) => {
    const found: string[] = [];
    let buffer = '';
    let stderr = '';
    let settled = false;

    const child = spawn(resolution.command, [...(resolution.argsPrefix ?? []), ...args], {
      cwd: folder.uri.fsPath,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const onAbort = (): void => {
      child.kill();
      finish(new Error('find_files: cancelled'));
    };
    const finish = (result: string[] | Error): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    const take = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (found.length >= maxResults) {
        if (!child.killed) child.kill();
        return;
      }
      found.push(trimmed.replace(/\\/g, '/').replace(/^\.\//, ''));
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) take(line);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (err) => {
      finish(new Error(`find_files: failed to start ripgrep: ${err.message}`));
    });
    child.once('close', (code) => {
      if (buffer.trim()) take(buffer);
      if (settled) return;
      // rg exits 1 for "no matches", which is a result, not a failure.
      if (found.length > 0 || code === 0 || code === 1) {
        finish(found.sort());
        return;
      }
      finish(new Error(`find_files: ${stderr.trim() || `ripgrep exited with code ${code}`}`));
    });
  });
}

export function makeFindFilesTool(
  resolveCommand: () => RipgrepResolution = () => resolveRipgrep(vscode.env.appRoot),
): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'find_files',
        description:
          'Find files by name or path using a glob pattern (e.g. "**/*.test.ts" or "src/**/index.*"). Returns matching workspace-relative paths. Matches file paths, not content — use search_code to search file contents.',
        parameters: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description:
                'Glob pattern to match against file paths, e.g. "**/*.ts". Anchored at the ' +
                'workspace root, so prefix a nested repository directory or lead with "**/".',
            },
            max_results: {
              type: 'integer',
              description: 'Maximum number of files to return. Defaults to 100.',
            },
            include_ignored: {
              type: 'boolean',
              description: 'Include gitignored files in glob results.',
            },
          },
          required: ['pattern'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args, context) => {
      context?.abortSignal?.throwIfAborted();
      const pattern = args['pattern'];
      if (typeof pattern !== 'string' || pattern.trim().length === 0) {
        throw new Error('find_files: pattern must be a non-empty string.');
      }
      const maxResults = typeof args['max_results'] === 'number' ? args['max_results'] : 100;
      const includeIgnored = args['include_ignored'] === true;

      const matches = await listWorkspaceFiles(
        pattern,
        maxResults,
        includeIgnored,
        resolveCommand(),
        context?.abortSignal,
      );
      context?.abortSignal?.throwIfAborted();
      if (matches.length === 0) {
        return (
          `No files match "${pattern}". The glob is anchored at the workspace root — ` +
          `prefix a nested repository's directory, or lead with "**/" to match at any depth.` +
          gitignoredNote(pattern, includeIgnored)
        );
      }
      return matches.join('\n');
    },
  };
}
