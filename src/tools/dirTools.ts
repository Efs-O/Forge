import { spawn } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';

function resolveUri(p: string): vscode.Uri {
  if (path.isAbsolute(p)) return vscode.Uri.file(p);
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) throw new Error('No workspace folder open.');
  return vscode.Uri.file(path.join(folders[0].uri.fsPath, p));
}

export function makeListDirectoryTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'list_directory',
        description: 'List entries in a directory. Returns each entry prefixed with [file] or [dir].',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path (absolute or workspace-relative).' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args) => {
      const uri = resolveUri(args['path'] as string);
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

function isContextEvent(event: RipgrepEvent): event is { type: 'context'; data: RipgrepContextData } {
  return event.type === 'context';
}

export function makeSearchCodeTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'search_code',
        description: 'Search for a string/pattern across workspace files. Returns matching file paths and surrounding context lines.',
        parameters: {
          type: 'object',
          properties: {
            query:       { type: 'string',  description: 'Text to search for (literal string).' },
            include:     { type: 'string',  description: 'Glob pattern of files to include, e.g. "**/*.ts". Defaults to "**/*".' },
            max_results: { type: 'integer', description: 'Maximum number of matching files to return. Defaults to 20.' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args) => {
      const query = args['query'] as string;
      const include = (args['include'] as string | undefined) ?? '**/*';
      const maxResults = (args['max_results'] as number | undefined) ?? 20;

      const matches = await searchWorkspaceText(query, include, maxResults);
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

async function searchWorkspaceText(query: string, include: string, maxResults: number): Promise<SearchCodeMatch[]> {
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

    const child = spawn('rg', args, {
      cwd: folder.uri.fsPath,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (result: SearchCodeMatch[] | Error): void => {
      if (settled) return;
      settled = true;
      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    const stopIfEnoughMatches = (): void => {
      if (matches.size < maxResults || child.killed) return;
      terminatedEarly = true;
      child.kill();
    };

    const appendEvent = (event: RipgrepEvent): void => {
      const data = isMatchEvent(event)
        ? event.data
        : isContextEvent(event)
          ? event.data
          : null;
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
