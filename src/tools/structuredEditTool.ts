import * as fs from 'fs';
import type { RegisteredTool } from './ToolRegistry';
import { resolveWorkspacePath } from '../util/WorkspacePaths';

const MAX_EDIT_OPERATIONS = 20;
const MAX_LINES_PER_OPERATION = 500;
const MAX_LINE_CHARS = 4_000;
const MAX_EXPECTED_CHARS = 64_000;
const MAX_REPLACEMENT_CHARS = 64_000;

export interface LineEditOperation {
  start_line: number;
  end_line: number;
  expected_lines: string[];
  replacement_lines: string[];
}

export interface LineEditResult {
  content: string;
  replacedLines: number;
  replacementLines: number;
}

export function applyLineEditsToContent(
  content: string,
  operations: readonly LineEditOperation[],
): LineEditResult {
  if (operations.length < 1 || operations.length > MAX_EDIT_OPERATIONS) {
    throw new Error(`apply_line_edits: operations must contain 1-${MAX_EDIT_OPERATIONS} entries`);
  }
  const withoutCrLf = content.replace(/\r\n/gu, '');
  if (withoutCrLf.includes('\r') || (content.includes('\r\n') && withoutCrLf.includes('\n'))) {
    throw new Error('apply_line_edits: mixed or bare-CR line endings are not supported');
  }
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const normalized = content.replace(/\r\n/gu, '\n');
  const finalEol = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  if (finalEol) lines.pop();

  let previousEnd = 0;
  let expectedChars = 0;
  let replacementChars = 0;
  for (const [index, operation] of operations.entries()) {
    validateOperation(operation, index, lines.length, previousEnd);
    previousEnd = operation.end_line;
    expectedChars += operation.expected_lines.reduce((total, line) => total + line.length, 0);
    if (expectedChars > MAX_EXPECTED_CHARS) {
      throw new Error(`apply_line_edits: expected lines exceed ${MAX_EXPECTED_CHARS} characters`);
    }
    replacementChars += operation.replacement_lines.reduce((total, line) => total + line.length, 0);
    if (replacementChars > MAX_REPLACEMENT_CHARS) {
      throw new Error(`apply_line_edits: replacements exceed ${MAX_REPLACEMENT_CHARS} characters`);
    }
    const actual = lines.slice(operation.start_line - 1, operation.end_line);
    if (!sameLines(actual, operation.expected_lines)) {
      throw new Error(
        `apply_line_edits: operation ${index + 1} is stale; expected_lines do not match the current file`,
      );
    }
  }

  const updated = [...lines];
  for (const operation of [...operations].reverse()) {
    updated.splice(
      operation.start_line - 1,
      operation.end_line - operation.start_line + 1,
      ...operation.replacement_lines,
    );
  }
  const result = updated.join(eol) + (finalEol ? eol : '');
  if (result === content) throw new Error('apply_line_edits: operations would not change the file');
  return {
    content: result,
    replacedLines: operations.reduce(
      (total, operation) => total + operation.end_line - operation.start_line + 1,
      0,
    ),
    replacementLines: operations.reduce(
      (total, operation) => total + operation.replacement_lines.length,
      0,
    ),
  };
}

export function makeApplyLineEditsTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'apply_line_edits',
        description:
          'Atomically apply ordered, non-overlapping replacements to one file using one-based inclusive line ranges. Read the file first and copy the current lines exactly into expected_lines; stale or out-of-range edits are rejected.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', minLength: 1 },
            operations: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_EDIT_OPERATIONS,
              items: {
                type: 'object',
                properties: {
                  start_line: { type: 'integer', minimum: 1 },
                  end_line: { type: 'integer', minimum: 1 },
                  expected_lines: lineArraySchema(1),
                  replacement_lines: lineArraySchema(0),
                },
                required: ['start_line', 'end_line', 'expected_lines', 'replacement_lines'],
                additionalProperties: false,
              },
            },
          },
          required: ['path', 'operations'],
          additionalProperties: false,
        },
      },
    },
    permission: 'write',
    mutation: { paths: (args) => [args['path'] as string], showDiff: true },
    handler: async (args) => {
      const suppliedPath = requireString(args['path'], 'path');
      const operations = parseOperations(args['operations']);
      const filePath = resolveWorkspacePath(suppliedPath);
      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch (error) {
        throw new Error(`apply_line_edits: cannot read file — ${(error as Error).message}`);
      }
      const result = applyLineEditsToContent(content, operations);
      fs.writeFileSync(filePath, result.content, 'utf8');
      return JSON.stringify({
        path: suppliedPath,
        operationsApplied: operations.length,
        replacedLines: result.replacedLines,
        replacementLines: result.replacementLines,
      });
    },
  };
}

function lineArraySchema(minItems: number): Record<string, unknown> {
  return {
    type: 'array',
    minItems,
    maxItems: MAX_LINES_PER_OPERATION,
    items: { type: 'string', maxLength: MAX_LINE_CHARS },
  };
}

function parseOperations(value: unknown): LineEditOperation[] {
  if (!Array.isArray(value)) throw new Error('apply_line_edits: operations must be an array');
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`apply_line_edits: operation ${index + 1} must be an object`);
    }
    const record = entry as Record<string, unknown>;
    return {
      start_line: requireInteger(record['start_line'], `operation ${index + 1} start_line`),
      end_line: requireInteger(record['end_line'], `operation ${index + 1} end_line`),
      expected_lines: requireLines(record['expected_lines'], index, 'expected_lines'),
      replacement_lines: requireLines(record['replacement_lines'], index, 'replacement_lines'),
    };
  });
}

function requireLines(value: unknown, index: number, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_LINES_PER_OPERATION ||
    value.some((line) => typeof line !== 'string' || line.length > MAX_LINE_CHARS)
  ) {
    throw new Error(`apply_line_edits: operation ${index + 1} has invalid ${field}`);
  }
  return value as string[];
}

function validateOperation(
  operation: LineEditOperation,
  index: number,
  lineCount: number,
  previousEnd: number,
): void {
  if (
    !Number.isInteger(operation.start_line) ||
    !Number.isInteger(operation.end_line) ||
    operation.start_line < 1 ||
    operation.end_line < operation.start_line ||
    operation.end_line > lineCount
  ) {
    throw new Error(`apply_line_edits: operation ${index + 1} has an out-of-range line span`);
  }
  if (operation.start_line <= previousEnd) {
    throw new Error('apply_line_edits: operations must be ordered and non-overlapping');
  }
  const expectedCount = operation.end_line - operation.start_line + 1;
  if (!validLineArray(operation.expected_lines) || !validLineArray(operation.replacement_lines)) {
    throw new Error(`apply_line_edits: operation ${index + 1} contains invalid lines`);
  }
  if (operation.expected_lines.length !== expectedCount) {
    throw new Error(
      `apply_line_edits: operation ${index + 1} expected_lines must contain ${expectedCount} lines`,
    );
  }
  if (operation.replacement_lines.length > MAX_LINES_PER_OPERATION) {
    throw new Error(`apply_line_edits: operation ${index + 1} has too many replacement lines`);
  }
}

function validLineArray(lines: readonly unknown[]): lines is readonly string[] {
  return (
    lines.length <= MAX_LINES_PER_OPERATION &&
    lines.every((line) => typeof line === 'string' && line.length <= MAX_LINE_CHARS)
  );
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`apply_line_edits: ${field} must be a non-empty string`);
  }
  return value;
}

function requireInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value)) throw new Error(`apply_line_edits: ${field} must be an integer`);
  return value as number;
}
