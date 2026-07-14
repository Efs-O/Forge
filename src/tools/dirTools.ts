import { spawn } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';
import { resolveWorkspaceUri } from '../util/WorkspacePaths';
import { resolveRipgrepBinary } from './RipgrepResolver';

export function makeListDirectoryTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'list_directory',
        description:
          'List entries in a directory. Returns each entry prefixed with [file] or [dir].',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Directory path (absolute or workspace-relative).',
            },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args) => {
      const uri = resolveWorkspaceUri(args['path'] as string);
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(uri);
      } catch (err) {
        throw new Error(`list_directory: ${(err as Error).message}`);
      }
      if (!entries.length) return '(empty directory)';
      return entries
        .map(([name, type]) => {
          const tag = type === vscode.FileType.Directory ? '[dir]' : '[file]';
          return `${tag} ${name}`;
        })
        .join('\n');
    },
  };
}

const OUTPUT_LINE_LIMIT = 50;
const CONTEXT_LINES = 2;
const SEARCH_EXCLUDES = ['!.git/**', '!node_modules/**', '!dist/**', '!out/**'];
const FIND_FILES_EXCLUDE = '{**/node_modules/**,**/dist/**,**/out/**,**/.git/**,**/.forge/**}';

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

export function makeFindFilesTool(): RegisteredTool {
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
              description: 'Glob pattern to match against file paths, e.g. "**/*.ts".',
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

      const matches = await vscode.workspace.findFiles(pattern, FIND_FILES_EXCLUDE, maxResults);
      context?.abortSignal?.throwIfAborted();
      if (matches.length === 0) return `No files match "${pattern}".`;

      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      return matches
        .map((uri) => (root ? path.relative(root, uri.fsPath).replace(/\\/g, '/') : uri.fsPath))
        .sort()
        .join('\n');
    },
  };
}

export function makeSearchCodeTool(): RegisteredTool {
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
              description: 'Glob pattern of files to include, e.g. "**/*.ts". Defaults to "**/*".',
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

      const matches = await searchWorkspaceText(query, include, maxResults, context?.abortSignal);
      if (matches.length === 0) return `No matches found for "${query}".`;

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

    const child = spawn(resolveRipgrepBinary(vscode.env.appRoot), args, {
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
      finish(new Error(`search_code: failed to start ripgrep: ${err.message}`));
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
