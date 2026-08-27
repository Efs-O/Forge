import { spawn } from 'child_process';
import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';
import { resolveRipgrep, type RipgrepResolution } from './RipgrepResolver';

const OUTPUT_LINE_LIMIT = 50;
const CONTEXT_LINES = 2;
/**
 * Per-file snippet cap.
 *
 * Without it, whichever file ripgrep reaches first spends the whole
 * OUTPUT_LINE_LIMIT and every other match is cut off. That is not hypothetical:
 * `.forge/embeddings.index.json` sorts first (dot-directory) and, being a copy
 * of every indexed chunk, matches nearly any query — so a search for "pickup"
 * in a workspace with an index returned 50 lines of index JSON and nothing from
 * the actual sources. The tool looked broken while working.
 */
export const SNIPPETS_PER_FILE_LIMIT = 8;
/**
 * Globs must be recursive to match below the search root. Bare `.git/**` is
 * anchored to that root, so it excluded only a top-level `.git` and happily
 * searched `subproject/.git/`, `subproject/node_modules/`, and so on —
 * `find_files` already got this right, which is why the two tools disagreed
 * about what is in the workspace. Both now share this one list.
 *
 * `.forge/` is excluded outright: it holds the semantic index, which is a
 * verbatim copy of the sources and would otherwise double every match.
 */
export const SEARCH_EXCLUDES = [
  '!**/.git/**',
  '!**/node_modules/**',
  '!**/dist/**',
  '!**/out/**',
  '!**/.forge/**',
];

interface SearchCodeMatch {
  path: string;
  snippets: string[];
}

interface RipgrepLineData {
  text?: string;
}

interface RipgrepPathData {
  text?: string;
}

interface RipgrepMatchData {
  path?: RipgrepPathData;
  lines?: RipgrepLineData;
  line_number?: number;
  submatches?: Array<{ start: number; end: number }>;
}

interface RipgrepContextData {
  path?: RipgrepPathData;
  lines?: RipgrepLineData;
  line_number?: number;
}

type RipgrepEvent =
  | { type: 'match'; data: RipgrepMatchData }
  | { type: 'context'; data: RipgrepContextData }
  | { type: string; data?: unknown };

function isMatchEvent(event: RipgrepEvent): event is { type: 'match'; data: RipgrepMatchData } {
  return event.type === 'match';
}

function isContextEvent(
  event: RipgrepEvent,
): event is { type: 'context'; data: RipgrepContextData } {
  return event.type === 'context';
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
  resolution: RipgrepResolution,
  signal?: AbortSignal,
): Promise<string[]> {
  signal?.throwIfAborted();
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('No workspace folder open.');

  const args = ['--files', '--glob', pattern, ...SEARCH_EXCLUDES.flatMap((g) => ['--glob', g])];

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

      const matches = await listWorkspaceFiles(
        pattern,
        maxResults,
        resolveCommand(),
        context?.abortSignal,
      );
      context?.abortSignal?.throwIfAborted();
      if (matches.length === 0) {
        return (
          `No files match "${pattern}". The glob is anchored at the workspace root — ` +
          `prefix a nested repository's directory, or lead with "**/" to match at any depth.`
        );
      }
      return matches.join('\n');
    },
  };
}

export function makeSearchCodeTool(
  resolveCommand: () => RipgrepResolution = () => resolveRipgrep(vscode.env.appRoot),
): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'search_code',
        description:
          'Search for a string/pattern across workspace files. Returns matching file paths and surrounding context lines.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Text to search for (literal string).' },
            include: {
              type: 'string',
              description:
                'Glob pattern of files to include, e.g. "**/*.ts". Defaults to "**/*". ' +
                'Anchored at the workspace root, so a path-bearing glob must start there: ' +
                'use "subproject/src/**/*.ts", or "**/src/**/*.ts" to match at any depth.',
            },
            max_results: {
              type: 'integer',
              description: 'Maximum number of matching files to return. Defaults to 20.',
            },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args, context) => {
      const query = args['query'] as string;
      const include = (args['include'] as string | undefined) ?? '**/*';
      const maxResults = (args['max_results'] as number | undefined) ?? 20;

      const matches = await searchWorkspaceText(
        query,
        include,
        maxResults,
        resolveCommand(),
        context?.abortSignal,
      );
      // Name the search mode on the miss. The query is passed to ripgrep with
      // --fixed-strings, so a regex like `\.heal\(` cannot match however much
      // of it is present in the file — and a bare "no matches" reported that
      // identically to a term that is genuinely absent, leaving the model to
      // re-guess the term rather than the syntax.
      if (matches.length === 0) {
        return (
          `No matches found for "${query}" in ${include} ` +
          `(literal text search — regular-expression syntax is not interpreted, ` +
          `and the include glob is anchored at the workspace root).`
        );
      }

      const outputLines: string[] = [];
      for (const match of matches) {
        if (outputLines.length >= OUTPUT_LINE_LIMIT) break;
        outputLines.push(`\n=== ${match.path} ===`);
        for (const snippet of match.snippets) {
          outputLines.push(snippet);
          if (outputLines.length >= OUTPUT_LINE_LIMIT) break;
        }
      }

      return outputLines.join('\n');
    },
  };
}

async function searchWorkspaceText(
  query: string,
  include: string,
  maxResults: number,
  resolution: RipgrepResolution,
  signal?: AbortSignal,
): Promise<SearchCodeMatch[]> {
  signal?.throwIfAborted();
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('No workspace folder open.');

  const args = [
    '--json',
    '--fixed-strings',
    '--line-number',
    '--with-filename',
    '--context',
    String(CONTEXT_LINES),
    '--glob',
    include,
    ...SEARCH_EXCLUDES.flatMap((glob) => ['--glob', glob]),
    query,
    '.',
  ];

  return new Promise<SearchCodeMatch[]>((resolve, reject) => {
    const matches = new Map<string, SearchCodeMatch>();
    let stdoutBuffer = '';
    let stderr = '';
    let settled = false;
    let terminatedEarly = false;

    const child = spawn(resolution.command, [...(resolution.argsPrefix ?? []), ...args], {
      cwd: folder.uri.fsPath,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const onAbort = (): void => {
      child.kill();
      finish(new Error('search_code: cancelled'));
    };

    const finish = (result: SearchCodeMatch[] | Error): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    const stopIfEnoughMatches = (): void => {
      if (matches.size < maxResults || child.killed) return;
      terminatedEarly = true;
      child.kill();
    };

    const appendEvent = (event: RipgrepEvent): void => {
      const data = isMatchEvent(event) ? event.data : isContextEvent(event) ? event.data : null;
      if (!data) return;

      const filePath = data.path?.text;
      const line = data.lines?.text;
      const lineNumber = data.line_number;
      if (!filePath || line === undefined || lineNumber === undefined) return;

      const normalizedPath = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
      let entry = matches.get(normalizedPath);
      if (!entry) {
        if (matches.size >= maxResults) {
          stopIfEnoughMatches();
          return;
        }
        entry = { path: normalizedPath, snippets: [] };
        matches.set(normalizedPath, entry);
      }

      if (entry.snippets.length >= SNIPPETS_PER_FILE_LIMIT) {
        stopIfEnoughMatches();
        return;
      }
      const marker = event.type === 'match' ? '>' : ' ';
      const snippet = `${marker} ${lineNumber}: ${line.replace(/\r?\n$/, '')}`;
      if (!entry.snippets.includes(snippet)) entry.snippets.push(snippet);
      stopIfEnoughMatches();
    };

    const flushStdout = (): void => {
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          appendEvent(JSON.parse(trimmed) as RipgrepEvent);
        } catch {
          // Ignore malformed rg output and continue parsing subsequent lines.
        }
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      flushStdout();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (err) => {
      const attempted = resolution.candidates.length
        ? resolution.candidates.join(', ')
        : '(VS Code app root unavailable)';
      finish(
        new Error(
          `search_code: failed to start ripgrep command "${resolution.command}": ${err.message}. ` +
            `Bundled candidates checked: ${attempted}`,
        ),
      );
    });
    child.once('close', (code) => {
      flushStdout();
      if (stdoutBuffer.trim().length > 0) {
        try {
          appendEvent(JSON.parse(stdoutBuffer.trim()) as RipgrepEvent);
        } catch {
          // Ignore malformed trailing output.
        }
      }

      if (settled) return;
      if (terminatedEarly || code === 0 || code === 1) {
        finish(Array.from(matches.values()));
        return;
      }

      const detail = stderr.trim() || `ripgrep exited with code ${code}`;
      finish(new Error(`search_code: ${detail}`));
    });
  });
}
