import * as path from 'path';
import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveUri(p: string): vscode.Uri {
  if (path.isAbsolute(p)) return vscode.Uri.file(p);
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) throw new Error('No workspace folder open.');
  return vscode.Uri.file(path.join(folders[0].uri.fsPath, p));
}

// ── list_directory ────────────────────────────────────────────────────────────

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

// ── search_code ───────────────────────────────────────────────────────────────

const OUTPUT_LINE_LIMIT = 50;
const CONTEXT_LINES = 5;

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
      const query      = args['query'] as string;
      const include    = (args['include'] as string | undefined) ?? '**/*';
      const maxResults = (args['max_results'] as number | undefined) ?? 20;

      const exclude = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}';
      const uris = await vscode.workspace.findFiles(include, exclude, maxResults * 5);

      const outputLines: string[] = [];
      let filesMatched = 0;

      for (const uri of uris) {
        if (filesMatched >= maxResults) break;
        if (outputLines.length >= OUTPUT_LINE_LIMIT) break;

        let text: string;
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          text = Buffer.from(bytes).toString('utf8');
        } catch {
          continue; // skip unreadable files (binary, permissions, etc.)
        }

        const lines = text.split('\n');
        const matchingLineNumbers: number[] = [];

        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(query)) {
            matchingLineNumbers.push(i);
          }
        }

        if (!matchingLineNumbers.length) continue;

        filesMatched++;
        const relPath = vscode.workspace.asRelativePath(uri, true);
        outputLines.push(`\n=== ${relPath} ===`);

        // Emit context blocks (deduplicated)
        const emitted = new Set<number>();
        for (const lineNum of matchingLineNumbers) {
          const start = Math.max(0, lineNum - Math.floor(CONTEXT_LINES / 2));
          const end   = Math.min(lines.length - 1, lineNum + Math.floor(CONTEXT_LINES / 2));
          for (let l = start; l <= end; l++) {
            if (!emitted.has(l)) {
              emitted.add(l);
              const marker = l === lineNum ? '>' : ' ';
              outputLines.push(`${marker} ${l + 1}: ${lines[l]}`);
              if (outputLines.length >= OUTPUT_LINE_LIMIT) break;
            }
          }
          if (outputLines.length >= OUTPUT_LINE_LIMIT) break;
        }
      }

      if (!filesMatched) return `No matches found for "${query}".`;
      return outputLines.join('\n');
    },
  };
}
