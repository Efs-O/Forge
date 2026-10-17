import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error -- the standalone catalog is a plain ESM script
import {
  extractToolAuditSnapshot,
  writeCoverageReport,
} from '../../scripts/tool-audit-catalog.mjs';
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

  it.each([
    ['minimum', { type: 'number', minimum: 2 }, 2, 1],
    ['maximum', { type: 'integer', maximum: 2 }, 2, 3],
    ['minLength', { type: 'string', minLength: 2 }, 'xy', 'x'],
    ['maxLength', { type: 'string', maxLength: 2 }, 'xy', 'xyz'],
    ['minItems', { type: 'array', minItems: 2, items: { type: 'integer' } }, [1, 2], [1]],
    ['maxItems', { type: 'array', maxItems: 2, items: { type: 'integer' } }, [1, 2], [1, 2, 3]],
  ])('validates %s at the bound and rejects a value past it', (_keyword, schema, atBound, past) => {
    expect(validateAgainstSchema(atBound, schema)).toEqual([]);
    expect(validateAgainstSchema(past, schema)).not.toEqual([]);
  });

  it('throws when a schema bound is not numeric', () => {
    expect(() => validateAgainstSchema(1, { type: 'integer', maximum: 'MAX_WAIT_SECONDS' })).toThrow(
      'Invalid schema bound arguments.maximum: expected a finite number',
    );
  });

  it('synthesizes values within numeric, string, and array bounds', () => {
    const schema = {
      type: 'object',
      properties: {
        count: { type: 'integer', minimum: 4, maximum: 5 },
        capped: { type: 'number', maximum: 0 },
        label: { type: 'string', minLength: 3, maxLength: 4 },
        items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'string' } },
      },
      required: ['count', 'capped', 'label', 'items'],
    };
    const args = synthesizeArgs(schema);
    expect(validateAgainstSchema(args, schema)).toEqual([]);
    expect(args.capped).toBeLessThanOrEqual(0);
  });
});

describe('local tool harness canonical inventory', () => {
  const root = path.resolve(__dirname, '../..');
  let snapshot!: Awaited<ReturnType<typeof extractToolAuditSnapshot>>;
  let output = '';
  let coverage = '';
  let committed = '';
  let temp: string | undefined;

  beforeAll(async () => {
    snapshot = await extractToolAuditSnapshot();
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tool-coverage-'));
    const report = path.join(temp, 'coverage.md');
    output = execFileSync(
      process.execPath,
      ['scripts/test-local-tools.mjs', '--list', '--coverage-report', report],
      { cwd: root, encoding: 'utf8' },
    );
    coverage = fs.readFileSync(report, 'utf8');
    committed = fs.readFileSync(path.join(root, 'docs/TOOL_COVERAGE.md'), 'utf8');
  }, 20_000);

  afterAll(() => {
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
  });

  it('contains every live registered native tool, including ask_agent and memory cleanup', () => {
    const names = output
      .trim()
      .split(/\r?\n/)
      .filter((line) => line.includes('\t'))
      .map((line) => line.split('\t')[0]);

    expect(names).toHaveLength(snapshot.names.length);
    expect(names.sort()).toEqual(snapshot.names);
    expect(names).toEqual(
      expect.arrayContaining([
        'apply_code_action',
        'manage_jobs',
        'ask_agent',
        'apply_line_edits',
        'ask_local_agent',
        'edit_notebook_cell',
        'read_tool_result',
        'forget',
        'view_image',
      ]),
    );
    // 20 s: spawns a child node process; the 5 s default expired under load
    // (audit 2026-09-26 F1).
  }, 20_000);

  it('keeps audit inventory names and function schemas equal to the live registry', () => {
    const inventoryNames = snapshot.definitions.map((definition) => definition.function.name).sort();
    expect(inventoryNames).toEqual(snapshot.names);
    const registryByName = new Map(
      snapshot.registryDefinitions.map((definition) => [definition.function.name, definition]),
    );
    for (const definition of snapshot.definitions) {
      expect(definition.function).toEqual(registryByName.get(definition.function.name)?.function);
    }
    expect(inventoryNames.filter((name) => name.startsWith('browser_'))).toHaveLength(15);
    expect(inventoryNames.filter((name) => name.startsWith('desktop_'))).toHaveLength(9);
  });

  it('generates a canonical coverage matrix with no missing native handler tests', () => {
    expect(coverage.match(/^\| [a-z_]+ \| native \|/gmu)).toHaveLength(snapshot.names.length);
    expect(coverage).not.toContain('| missing |');
    expect(coverage).toContain('| search_code | native | read | harness | automated |');
    expect(coverage).not.toContain('Coordinator');
    expect(coverage).toContain('| browser_click | native | browser | harness |');
    expect(coverage).toContain('| desktop_click | native | desktop | harness |');
    const withoutGeneratedAt = (value: string) =>
      value.replace(/^Generated: .*$/mu, 'Generated: <ignored>');
    expect(withoutGeneratedAt(coverage)).toBe(withoutGeneratedAt(committed));
  });

  it('fails loudly when the coverage matrix encounters an unknown permission', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tool-coverage-invalid-'));
    try {
      expect(() =>
        writeCoverageReport(
          path.join(temp, 'coverage.md'),
          [
            {
              function: { name: 'bad_permission', description: '', parameters: {} },
              origin: 'native',
              permission: 'future-permission',
            },
          ],
        ),
      ).toThrow('Coverage matrix does not know permission future-permission');
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
