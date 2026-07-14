import * as fs from 'fs';
import * as path from 'path';
import type { RegisteredTool, ToolScope } from '../tools/ToolRegistry';
import { capResultText } from '../tools/resultCap';
import { isPathInside, resolveWorkspacePath } from '../util/WorkspacePaths';
import {
  MAX_DIRECTORY_ENTRIES,
  MAX_WORKER_READ_BYTES,
  MAX_WORKER_READ_FILE_BYTES,
  MAX_WORKER_TOOL_RESULT_CHARS,
  MAX_WORKER_TOOL_RESULT_TOTAL_CHARS,
} from './limits';
import type { WorkerAccess } from './types';
import { isWorkerDiscoveryTool, validateWorkerDiscoveryArgs } from './WorkerToolValidators';

const WORKER_READ_TOOL_NAMES = [
  'read_file',
  'list_directory',
  'find_files',
  'search_code',
  'get_document_symbols',
  'get_diagnostics',
] as const;
const WORKER_WRITE_TOOL_NAMES = ['write_file', 'replace_in_file'] as const;

function realContainedPath(
  input: string,
  workspaceRoot: string,
  allowMissing: boolean,
  allowAbsolute = false,
): string {
  const resolved = resolveWorkspacePath(input, {
    workspaceRoot,
    allowAbsolute,
    mustBeInsideWorkspace: true,
  });
  const realRoot = fs.realpathSync(workspaceRoot);
  if (fs.existsSync(resolved)) {
    const real = fs.realpathSync(resolved);
    if (!isPathInside(realRoot, real)) throw new Error(`Worker path escapes workspace: ${input}`);
    return real;
  }
  if (!allowMissing) throw new Error(`Worker path does not exist: ${input}`);
  let parent = path.dirname(resolved);
  while (!fs.existsSync(parent) && parent !== path.dirname(parent)) parent = path.dirname(parent);
  const realParent = fs.realpathSync(parent);
  if (!isPathInside(realRoot, realParent)) {
    throw new Error(`Worker path parent escapes workspace: ${input}`);
  }
  return path.join(realParent, path.relative(parent, resolved));
}

export class WorkerAccessPolicy {
  private readonly writable: Set<string>;
  private readonly changed = new Set<string>();
  private readBytes = 0;
  private resultChars = 0;

  constructor(
    private readonly workspaceRoot: string,
    private readonly access: WorkerAccess,
    allowedPaths: readonly string[],
  ) {
    this.writable = new Set(
      allowedPaths.map((candidate) => realContainedPath(candidate, workspaceRoot, true)),
    );
  }

  scope(): ToolScope {
    return {
      allowedNames: new Set([
        ...WORKER_READ_TOOL_NAMES,
        ...(this.access === 'write' ? WORKER_WRITE_TOOL_NAMES : []),
      ]),
      validate: (tool, args) => this.validate(tool, args),
      validateMutationPaths: (paths) => this.validateMutationPaths(paths),
      transformResult: (tool, result) => this.transformResult(tool, result),
      onResult: (tool, args, result) => this.recordResult(tool, args, result),
    };
  }

  writablePaths(): readonly string[] {
    return [...this.writable];
  }

  changedPaths(): string[] {
    return [...this.changed];
  }

  private validate(tool: RegisteredTool, args: Record<string, unknown>): void {
    const name = tool.definition.function.name;
    if (name === 'read_file') {
      const target = realContainedPath(String(args['path'] ?? ''), this.workspaceRoot, false);
      const stat = fs.statSync(target);
      if (!stat.isFile()) throw new Error(`Worker read target is not a file: ${args['path']}`);
      if (stat.size > MAX_WORKER_READ_FILE_BYTES) {
        throw new Error(`Worker read exceeds ${MAX_WORKER_READ_FILE_BYTES} bytes: ${args['path']}`);
      }
      if (this.readBytes + stat.size > MAX_WORKER_READ_BYTES) {
        throw new Error(`Worker cumulative read budget exceeds ${MAX_WORKER_READ_BYTES} bytes`);
      }
      this.readBytes += stat.size;
      return;
    }
    if (name === 'list_directory') {
      const target = realContainedPath(String(args['path'] ?? ''), this.workspaceRoot, false);
      if (!fs.statSync(target).isDirectory()) {
        throw new Error(`Worker list target is not a directory: ${args['path']}`);
      }
      return;
    }
    if (isWorkerDiscoveryTool(name)) {
      validateWorkerDiscoveryArgs(name, args);
      if (name === 'get_document_symbols' || name === 'get_diagnostics') {
        const target = realContainedPath(String(args['path']), this.workspaceRoot, false);
        if (!fs.statSync(target).isFile()) {
          throw new Error(`Worker discovery target is not a file: ${args['path']}`);
        }
      }
      return;
    }
    const field = name === 'replace_in_file' ? 'filepath' : 'path';
    const target = realContainedPath(String(args[field] ?? ''), this.workspaceRoot, true);
    if (!this.writable.has(target))
      throw new Error(`Worker write path is not assigned: ${args[field]}`);
  }

  private transformResult(tool: RegisteredTool, result: string): string {
    let bounded = result;
    if (tool.definition.function.name === 'list_directory') {
      bounded = result.split('\n').slice(0, MAX_DIRECTORY_ENTRIES).join('\n');
    }
    bounded = capResultText(bounded, MAX_WORKER_TOOL_RESULT_CHARS);
    if (this.resultChars + bounded.length > MAX_WORKER_TOOL_RESULT_TOTAL_CHARS) {
      throw new Error(
        `Worker cumulative tool-result budget exceeds ${MAX_WORKER_TOOL_RESULT_TOTAL_CHARS} characters`,
      );
    }
    this.resultChars += bounded.length;
    return bounded;
  }

  private validateMutationPaths(paths: readonly string[]): void {
    for (const candidate of paths) {
      const target = realContainedPath(candidate, this.workspaceRoot, true, true);
      if (!this.writable.has(target)) {
        throw new Error(`Worker mutation path is not assigned: ${candidate}`);
      }
    }
  }

  private recordResult(tool: RegisteredTool, args: Record<string, unknown>, result: string): void {
    if (!tool.mutation || result.startsWith('Error:') || result.startsWith('User declined:'))
      return;
    const name = tool.definition.function.name;
    const field = name === 'replace_in_file' ? 'filepath' : 'path';
    this.changed.add(realContainedPath(String(args[field] ?? ''), this.workspaceRoot, true));
  }
}
