import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RegisteredTool } from '../../src/tools/ToolRegistry';
import { WorkerAccessPolicy } from '../../src/workers/WorkerAccessPolicy';

function tool(name: string, mutation = false): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: { name, description: name, parameters: { type: 'object', properties: {} } },
    },
    permission: mutation ? 'write' : 'read',
    mutation,
    handler: () => '',
  };
}

describe('WorkerAccessPolicy', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-worker-policy-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'read.ts'), 'source');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('permits workspace reads but only exact assigned writes', () => {
    const policy = new WorkerAccessPolicy(root, 'write', ['src/write.ts']);
    const scope = policy.scope();
    expect(() => scope.validate?.(tool('read_file'), { path: 'src/read.ts' })).not.toThrow();
    expect(() =>
      scope.validate?.(tool('write_file', true), { path: 'src/write.ts' }),
    ).not.toThrow();
    expect(() => scope.validate?.(tool('write_file', true), { path: 'src/other.ts' })).toThrow(
      'not assigned',
    );
  });

  it('rejects paths outside the workspace and records successful assigned writes', () => {
    const policy = new WorkerAccessPolicy(root, 'write', ['src/write.ts']);
    const scope = policy.scope();
    expect(() => scope.validate?.(tool('read_file'), { path: '../outside.ts' })).toThrow(
      'outside the workspace',
    );
    scope.onResult?.(tool('write_file', true), { path: 'src/write.ts' }, 'Wrote file');
    expect(policy.changedPaths()).toEqual([path.join(fs.realpathSync(root), 'src', 'write.ts')]);
  });

  it('caps directory listings before returning them to a worker', () => {
    const policy = new WorkerAccessPolicy(root, 'write', ['src/write.ts']);
    const transformed = policy
      .scope()
      .transformResult?.(
        tool('list_directory'),
        Array.from({ length: 700 }, (_, i) => `${i}`).join('\n'),
      );
    expect(transformed?.split('\n')).toHaveLength(500);
  });

  it('re-checks static and dynamic mutation paths against exact ownership', () => {
    const scope = new WorkerAccessPolicy(root, 'write', ['src/write.ts']).scope();
    expect(() => scope.validateMutationPaths?.(['src/write.ts'])).not.toThrow();
    expect(() => scope.validateMutationPaths?.(['src/other.ts'])).toThrow('not assigned');
  });

  it('does not advertise or permit mutation tools for read-only workers', () => {
    const scope = new WorkerAccessPolicy(root, 'read', []).scope();
    expect(scope.allowedNames).toEqual(
      new Set([
        'read_file',
        'list_directory',
        'find_files',
        'search_code',
        'get_document_symbols',
        'get_diagnostics',
      ]),
    );
    expect(() => scope.validate?.(tool('write_file', true), { path: 'src/write.ts' })).toThrow(
      'not assigned',
    );
  });

  it('advertises exactly the documented nine tools to write workers', () => {
    const scope = new WorkerAccessPolicy(root, 'write', ['src/write.ts']).scope();
    expect(scope.allowedNames).toEqual(
      new Set([
        'read_file',
        'list_directory',
        'find_files',
        'search_code',
        'get_document_symbols',
        'get_diagnostics',
        'write_file',
        'edit_file',
        'apply_line_edits',
      ]),
    );
  });

  it('allows structured edits only on the exact assigned path', () => {
    const scope = new WorkerAccessPolicy(root, 'write', ['src/write.ts']).scope();
    expect(scope.allowedNames.has('apply_line_edits')).toBe(true);
    expect(() =>
      scope.validate?.(tool('apply_line_edits', true), {
        path: 'src/write.ts',
        operations: [],
      }),
    ).not.toThrow();
    expect(() =>
      scope.validate?.(tool('apply_line_edits', true), {
        path: 'src/other.ts',
        operations: [],
      }),
    ).toThrow('not assigned');
  });

  it('permits bounded workspace discovery for read-only workers', () => {
    const scope = new WorkerAccessPolicy(root, 'read', []).scope();
    expect(() =>
      scope.validate?.(tool('find_files'), { pattern: 'src/**/*.ts', max_results: 100 }),
    ).not.toThrow();
    expect(() =>
      scope.validate?.(tool('search_code'), {
        query: 'source',
        include: 'src/**/*.ts',
        max_results: 20,
      }),
    ).not.toThrow();
    expect(() =>
      scope.validate?.(tool('get_document_symbols'), { path: 'src/read.ts' }),
    ).not.toThrow();
    expect(() => scope.validate?.(tool('get_diagnostics'), { path: 'src/read.ts' })).not.toThrow();
  });

  it('rejects unbounded or workspace-wide discovery arguments', () => {
    const scope = new WorkerAccessPolicy(root, 'read', []).scope();
    expect(() =>
      scope.validate?.(tool('find_files'), { pattern: '../**/*', max_results: 100 }),
    ).toThrow('must not traverse');
    expect(() =>
      scope.validate?.(tool('search_code'), { query: 'source', max_results: 21 }),
    ).toThrow('1 to 20');
    expect(() => scope.validate?.(tool('get_diagnostics'), {})).toThrow('non-empty string');
    expect(() =>
      scope.validate?.(tool('get_document_symbols'), { path: path.join(root, 'src', 'read.ts') }),
    ).toThrow('Absolute paths are not allowed');
  });
});
