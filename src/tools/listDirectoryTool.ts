import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';
import { resolveWorkspaceUri } from '../util/WorkspacePaths';

/**
 * Above this many entries the per-entry `stat` is skipped.
 *
 * `readDirectory` is one call; size and age cost one `stat` each, and on a
 * mapped network drive those are round trips. A directory this large is being
 * scanned for a name, not watched for growth, so the metadata is not worth the
 * latency — and the skip is reported rather than silently degrading.
 */
const STAT_ENTRY_LIMIT = 500;

export function makeListDirectoryTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'list_directory',
        description:
          'List entries in a directory. Returns each entry prefixed with [file] or [dir], with its size and how long ago it was modified. Use the size and age to tell whether a long-running job is still making progress: call this twice and compare, rather than waiting on a process that prints nothing. Directories over ' +
          `${String(STAT_ENTRY_LIMIT)} entries are listed without size or age.`,
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

      if (entries.length > STAT_ENTRY_LIMIT) {
        const plain = entries.map(([name, type]) => `${entryTag(type)} ${name}`);
        plain.push(
          `(${String(entries.length)} entries — over the ${String(STAT_ENTRY_LIMIT)}-entry limit, so size and age were not read)`,
        );
        return plain.join('\n');
      }

      const stats = await Promise.all(
        entries.map(async ([name]) => {
          try {
            return await vscode.workspace.fs.stat(vscode.Uri.joinPath(uri, name));
          } catch {
            // A file can vanish or be locked between the listing and the stat —
            // a job actively writing here is the whole reason to call this tool.
            // Drop the metadata for that one entry; never fail the listing.
            return undefined;
          }
        }),
      );
      // Read the clock after the asynchronous stats. Capturing it before them
      // can make a concurrently written file appear newer than "now".
      const now = Date.now();

      return entries
        .map(([name, type], index) => {
          const line = `${entryTag(type)} ${name}`;
          const stat = stats[index];
          if (!stat) return line;
          const parts =
            type === vscode.FileType.Directory
              ? [formatAge(now - stat.mtime)]
              : [formatSize(stat.size), formatAge(now - stat.mtime)];
          return `${line} (${parts.join(', ')})`;
        })
        .join('\n');
    },
  };
}

function entryTag(type: vscode.FileType): string {
  return type === vscode.FileType.Directory ? '[dir]' : '[file]';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Two decimals so two polls of a growing file differ visibly: at GB scale one
  // decimal hides 50 MB of progress and a downloading file reads as stalled.
  return `${value.toFixed(2)} ${units[unit] ?? 'TB'}`;
}

/**
 * Age, not a timestamp. ISO timestamps are UTC and read as hours-wrong against
 * the user's clock, and "did this change just now" is the actual question — so
 * answer it directly rather than making the caller subtract. Mirrors the same
 * decision in `list_executions`.
 */
export function formatAge(ms: number): string {
  // Clock skew on a network share can date a file in the future.
  // Local filesystems also round timestamps differently; tolerate the normal
  // sub-two-second skew instead of calling a file created "now" futuristic.
  if (ms < -2_000) return 'modified in the future';
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${String(seconds)}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${String(hours)}h ago`;
  return `${String(Math.round(hours / 24))}d ago`;
}
