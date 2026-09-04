import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
// The harness core is deliberately plain ESM so the standalone Node audit script and
// Vitest exercise the exact same comparison implementation.
// @ts-expect-error -- the JavaScript audit helper intentionally has no production typings
import {
  parseToolArguments,
  structuralArgsEqual,
  synthesizeArgs,
  validateAgainstSchema,
} from '../../scripts/tool-harness-core.mjs';

describe('local tool harness argument classification', () => {
  it('treats reordered and nested reordered object keys as equal', () => {
    expect(structuralArgsEqual({ b: 2, a: { d: 4, c: 3 } }, { a: { c: 3, d: 4 }, b: 2 })).toBe(
      true,
    );
  });

  it('preserves array order significance', () => {
    expect(structuralArgsEqual({ values: [2, 1] }, { values: [1, 2] })).toBe(false);
  });

  it('detects changed scalar values', () => {
    expect(structuralArgsEqual({ value: 2 }, { value: 1 })).toBe(false);
  });

  it('reports invalid JSON independently', () => {
    expect(parseToolArguments('{invalid')).toMatchObject({ valid: false, value: undefined });
    expect(parseToolArguments('{"valid":true}')).toEqual({
      valid: true,
      value: { valid: true },
      error: '',
    });
  });

  it('reports schema-invalid JSON separately from JSON parsing', () => {
    const schema = {
      type: 'object',
      properties: { count: { type: 'integer' } },
      required: ['count'],
      additionalProperties: false,
    };
    expect(parseToolArguments('{"count":"wrong"}').valid).toBe(true);
    expect(validateAgainstSchema({ count: 'wrong' }, schema)).toEqual([
      'arguments.count must be integer',
    ]);
  });

  it('synthesizes valid fixtures for nullable anyOf schemas', () => {
    const schema = {
      type: 'object',
      properties: {
        limit: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
        tags: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
      },
      required: ['limit', 'tags'],
    };
    const value = synthesizeArgs(schema);
    expect(value).toEqual({ limit: 0, tags: ['test_tags'] });
    expect(validateAgainstSchema(value, schema)).toEqual([]);
  });
});

describe('local tool harness canonical inventory', () => {
  it('contains all 68 registered native tools, including tool-result recovery', () => {
    const root = path.resolve(__dirname, '../..');
    const output = execFileSync(process.execPath, ['scripts/test-local-tools.mjs', '--list'], {
      cwd: root,
      encoding: 'utf8',
    });
    const names = output
      .trim()
      .split(/\r?\n/)
      .map((line) => line.split('\t')[0]);

    expect(names).toHaveLength(68);
    expect(names).toEqual(
      expect.arrayContaining([
        'apply_code_action',
        'apply_line_edits',
        'ask_local_agent',
        'edit_notebook_cell',
        'read_tool_result',
        'run_workspace_task',
        'view_image',
      ]),
    );
  });

  it('generates a canonical coverage matrix with no missing native handler tests', () => {
    const root = path.resolve(__dirname, '../..');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tool-coverage-'));
    const report = path.join(temp, 'coverage.md');
    try {
      execFileSync(
        process.execPath,
        ['scripts/test-local-tools.mjs', '--list', '--coverage-report', report],
        { cwd: root, encoding: 'utf8' },
      );
      const content = fs.readFileSync(report, 'utf8');
      expect(content.match(/^\| [a-z_]+ \| native \|/gmu)).toHaveLength(68);
      expect(content).not.toContain('| missing |');
      expect(content).toContain('| search_code | native | read | yes |');
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
