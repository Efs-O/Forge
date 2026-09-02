import * as fs from 'node:fs';
import * as path from 'node:path';
import { registerBenchmarkTerminalTools } from './terminalTools';
import {
  ToolRegistry,
  type RegisteredTool,
  type ToolHandler,
  type ToolPermission,
} from '../tools/ToolRegistry';
import type { ToolCall, ToolDefinition } from '../llm/types';

const MAX_RESULT_CHARS = 12_000;
const MAX_WRITE_CHARS = 6_000;
const EXCLUDED = new Set(['.git', 'node_modules', '.venv', '__pycache__', 'dist', 'build']);

export const BENCHMARK_TOOL_NAMES = [
  'read_file',
  'find_files',
  'search_code',
  'write_file',
  'append_file',
  'edit_file',
  'run_terminal',
  'run_tests',
] as const;

export interface BenchmarkToolHost {
  registry: ToolRegistry;
  allowed: Set<ToolPermission>;
  definitions(): ToolDefinition[];
  dispatch(
    call: ToolCall,
    signal: AbortSignal,
    onMutation?: (paths: string[]) => void,
  ): Promise<string>;
}

function bounded(text: string): string {
  return text.length <= MAX_RESULT_CHARS
    ? text
    : `${text.slice(0, MAX_RESULT_CHARS)}\n[output truncated]`;
}

function inside(root: string, requested: string): string {
  const candidate = path.resolve(root, requested);
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path escapes the benchmark workspace: ${requested}`);
  }
  return candidate;
}

function relative(root: string, candidate: string): string {
  return path.relative(root, candidate).replace(/\\/gu, '/');
}

function walk(root: string, current = root): string[] {
  const output: string[] = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (EXCLUDED.has(entry.name)) continue;
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) output.push(...walk(root, full));
    else if (entry.isFile()) output.push(relative(root, full));
  }
  return output;
}

function globRegex(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      source += '.*';
      index += 1;
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[\\^$+?.()|[\]{}]/gu, '\\$&');
  }
  return new RegExp(`^${source}$`, 'u');
}

function filePath(args: Record<string, unknown>, root: string): string {
  const value = args.path;
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error('path must be a non-empty string.');
  return inside(root, value);
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') throw new Error(`${key} must be a string.`);
  return value;
}

function fileTool(
  name: string,
  description: string,
  handler: ToolHandler,
  permission: ToolPermission,
  mutation?: (args: Record<string, unknown>) => string[],
): RegisteredTool {
  return {
    definition: {
      type: 'function' as const,
      function: {
        name,
        description,
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    permission,
    handler,
    ...(mutation ? { mutation: { paths: mutation, showDiff: true } } : {}),
  };
}

export function createBenchmarkToolHost(root: string): BenchmarkToolHost {
  const registry = new ToolRegistry();
  const read = fileTool(
    'read_file',
    'Read a UTF-8 text file in the benchmark workspace.',
    async (args) => {
      const target = filePath(args, root);
      const content = fs.readFileSync(target, 'utf8');
      const start = typeof args.start_line === 'number' ? Math.max(1, args.start_line) : 1;
      const end = typeof args.end_line === 'number' ? Math.max(start, args.end_line) : undefined;
      if (start === 1 && end === undefined) return bounded(content);
      const lines = content.split(/\r?\n/u);
      return bounded(lines.slice(start - 1, end).join('\n'));
    },
    'read',
  );
  read.definition.function.parameters = {
    type: 'object',
    properties: {
      path: { type: 'string' },
      start_line: { type: 'integer', minimum: 1 },
      end_line: { type: 'integer', minimum: 1 },
    },
    required: ['path'],
    additionalProperties: false,
  };
  registry.register(read);

  registry.register({
    definition: {
      type: 'function',
      function: {
        name: 'find_files',
        description: 'Find workspace files matching a glob.',
        parameters: {
          type: 'object',
          properties: { pattern: { type: 'string' }, max_results: { type: 'integer', minimum: 1 } },
          required: ['pattern'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args) => {
      const pattern = stringArg(args, 'pattern').replace(/\\/gu, '/');
      const limit =
        typeof args.max_results === 'number' ? Math.min(500, Math.max(1, args.max_results)) : 100;
      return (
        walk(root)
          .filter((file) => globRegex(pattern).test(file))
          .sort()
          .slice(0, limit)
          .join('\n') || 'No matching files.'
      );
    },
  });
  registry.register({
    definition: {
      type: 'function',
      function: {
        name: 'search_code',
        description: 'Search literal text in workspace files.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            include: { type: 'string' },
            max_results: { type: 'integer', minimum: 1 },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args) => {
      const query = stringArg(args, 'query');
      const matcher = globRegex(
        typeof args.include === 'string' ? args.include.replace(/\\/gu, '/') : '**/*',
      );
      const limit =
        typeof args.max_results === 'number' ? Math.min(100, Math.max(1, args.max_results)) : 20;
      const hits: string[] = [];
      for (const file of walk(root)) {
        if (!matcher.test(file) || hits.length >= limit) continue;
        try {
          const content = fs.readFileSync(inside(root, file), 'utf8');
          const line = content.split(/\r?\n/u).findIndex((entry) => entry.includes(query));
          if (line >= 0) hits.push(`${file}:${line + 1}: ${content.split(/\r?\n/u)[line]}`);
        } catch {
          /* Binary and unreadable files are not search candidates. */
        }
      }
      return hits.join('\n') || 'No matches found.';
    },
  });

  const write = fileTool(
    'write_file',
    'Write a UTF-8 file. Keep each call under 6000 characters; append_file builds larger files.',
    async (args) => {
      const content = stringArg(args, 'content');
      if (content.length > MAX_WRITE_CHARS)
        throw new Error(`content is limited to ${MAX_WRITE_CHARS} characters; use append_file.`);
      const target = filePath(args, root);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
      return `Wrote ${relative(root, target)}`;
    },
    'write',
    (args) => [stringArg(args, 'path')],
  );
  write.definition.function.parameters = {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string', maxLength: MAX_WRITE_CHARS },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  };
  registry.register(write);
  const append = fileTool(
    'append_file',
    'Append a UTF-8 chunk to a file, under 6000 characters per call.',
    async (args) => {
      const content = stringArg(args, 'content');
      if (content.length > MAX_WRITE_CHARS)
        throw new Error(`content is limited to ${MAX_WRITE_CHARS} characters.`);
      const target = filePath(args, root);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.appendFileSync(target, content, 'utf8');
      return `Appended ${content.length} characters to ${relative(root, target)}`;
    },
    'write',
    (args) => [stringArg(args, 'path')],
  );
  append.definition.function.parameters = {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string', maxLength: MAX_WRITE_CHARS },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  };
  registry.register(append);
  const edit = fileTool(
    'edit_file',
    'Replace exact text in a UTF-8 file. Read the file first and make the smallest change.',
    async (args) => {
      const target = filePath(args, root);
      const oldText = stringArg(args, 'old_text');
      if (!oldText) throw new Error('old_text must not be empty.');
      const newText = stringArg(args, 'new_text');
      const before = fs.readFileSync(target, 'utf8');
      const count = before.split(oldText).length - 1;
      if (count === 0) throw new Error('old_text was not found; re-read the current file.');
      if (count > 1 && args.replace_all !== true)
        throw new Error(
          `old_text matched ${count} times; set replace_all or provide more context.`,
        );
      const after =
        args.replace_all === true
          ? before.split(oldText).join(newText)
          : before.replace(oldText, newText);
      fs.writeFileSync(target, after, 'utf8');
      return `Edited ${relative(root, target)}`;
    },
    'write',
    (args) => [stringArg(args, 'path')],
  );
  edit.definition.function.parameters = {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_text: { type: 'string' },
      new_text: { type: 'string' },
      replace_all: { type: 'boolean' },
    },
    required: ['path', 'old_text', 'new_text'],
    additionalProperties: false,
  };
  registry.register(edit);

  registerBenchmarkTerminalTools(registry, root);

  const allowed = new Set<ToolPermission>(['read', 'write', 'terminal']);
  const definitions = (): ToolDefinition[] => {
    const current = registry.definitions(allowed);
    const names = current.map((definition) => definition.function.name);
    if (
      names.length !== BENCHMARK_TOOL_NAMES.length ||
      names.some((name, index) => name !== BENCHMARK_TOOL_NAMES[index])
    ) {
      throw new Error(`Benchmark tool allowlist drifted: ${names.join(', ')}`);
    }
    return current;
  };
  return {
    registry,
    allowed,
    definitions,
    dispatch: async (call, signal, onMutation) => {
      const tool = registry.get(call.function.name);
      if (!tool) throw new Error(`Unknown benchmark tool ${call.function.name}`);
      const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      onMutation?.(tool.mutation?.paths(args) ?? []);
      try {
        const result = await registry.dispatch(call.function.name, args, allowed, {
          beforeMutate: () => undefined,
          abortSignal: signal,
        });
        return typeof result === 'string' ? result : result.text;
      } catch (error) {
        return `Tool ${call.function.name} failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}
