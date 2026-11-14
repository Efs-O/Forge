import * as fs from 'fs';
import type { RegisteredTool } from './ToolRegistry';
import { defaultWorkspaceRoot, resolveRealWorkspacePath } from '../util/WorkspacePaths';
import { agentWriteOptions, delayedWriteNote, writeFileAtomic } from '../util/atomicWrite';
import { guardTipsWrite, tipsWriteNote } from './tipsWriteGuard';
import { withFileLengthWarning, type FileLengthWarningGetter } from './fileLengthWarning';
import { NO_PROBLEM_WATCHER, withProblemNote, type ProblemWatcher } from './editDiagnostics';
import { capAtLineBoundary, numberedBlock, throwStaleRefusal } from './structuredEditRefusals';

const MAX_EDIT_OPERATIONS = 20;
const MAX_LINES_PER_OPERATION = 500;
const MAX_LINE_CHARS = 4_000;
const MAX_EXPECTED_CHARS = 64_000;
const MAX_REPLACEMENT_CHARS = 64_000;
const OPERATION_REQUIRED_FIELDS = ['expected_lines', 'replacement_lines'] as const;

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
  /** Operations whose stated `end_line` miscounted `expected_lines` but whose text matched the
   *  file exactly at the named `start_line` — the range was corrected and the edit applied. */
  autoAligned: Array<{ index: number; startLine: number; statedEnd: number; actualEnd: number }>;
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

  const ordered = operations
    .map((operation, index) => ({ operation, index: index + 1 }))
    .sort((left, right) => left.operation.start_line - right.operation.start_line);
  // Prevention, not recovery: a miscounted `end_line` whose text nevertheless matches the file at
  // the named `start_line` is a miscount, not a disagreement — the tool corrects its own argument
  // and says so, instead of refusing a call that could not have meant anything else. The match
  // must be exact AT the stated start; a block that matches only somewhere else stays the refusal
  // that names the lines, because then which copy was meant is genuinely the model's call.
  const autoAligned: Array<{
    index: number;
    startLine: number;
    statedEnd: number;
    actualEnd: number;
  }> = [];
  for (const entry of ordered) {
    const actualEnd = alignedEndLine(entry.operation, lines);
    if (actualEnd !== undefined) {
      autoAligned.push({
        index: entry.index,
        startLine: entry.operation.start_line,
        statedEnd: entry.operation.end_line,
        actualEnd,
      });
      entry.operation = { ...entry.operation, end_line: actualEnd };
    }
  }
  let previous: { operation: LineEditOperation; index: number } | undefined;
  let expectedChars = 0;
  let replacementChars = 0;
  for (const { operation, index } of ordered) {
    validateOperation(operation, index - 1, lines);
    if (previous && operation.start_line <= previous.operation.end_line) {
      throw new Error(
        `apply_line_edits: operation ${previous.index} lines ${previous.operation.start_line}-${previous.operation.end_line} ` +
          `overlaps operation ${index} lines ${operation.start_line}-${operation.end_line}`,
      );
    }
    previous = { operation, index };
    expectedChars += operation.expected_lines.reduce((total, line) => total + line.length, 0);
    if (expectedChars > MAX_EXPECTED_CHARS) {
      throw new Error(`apply_line_edits: expected lines exceed ${MAX_EXPECTED_CHARS} characters`);
    }
    replacementChars += operation.replacement_lines.reduce((total, line) => total + line.length, 0);
    if (replacementChars > MAX_REPLACEMENT_CHARS) {
      throw new Error(`apply_line_edits: replacements exceed ${MAX_REPLACEMENT_CHARS} characters`);
    }
    const actual = lines.slice(operation.start_line - 1, operation.end_line);
    if (!sameLines(actual, operation.expected_lines)) throwStaleRefusal(operation, index, lines);
  }

  const updated = [...lines];
  for (const { operation } of [...ordered].reverse()) {
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
    replacedLines: ordered.reduce(
      (total, entry) => total + entry.operation.end_line - entry.operation.start_line + 1,
      0,
    ),
    autoAligned,
    replacementLines: ordered.reduce(
      (total, entry) => total + entry.operation.replacement_lines.length,
      0,
    ),
  };
}

export function makeApplyLineEditsTool(
  extraRoots: () => readonly string[] = () => [],
  lengthWarning: FileLengthWarningGetter = () => undefined,
  watchProblems: ProblemWatcher = NO_PROBLEM_WATCHER,
): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'apply_line_edits',
        description:
          'Atomically apply non-overlapping replacements to one file using one-based inclusive line ranges; operations are applied in line order. Read the file first and copy the current lines exactly into expected_lines; stale or out-of-range edits are rejected. Give start_line, end_line, or both; a missing one is derived from the length of expected_lines. The file goes at the top level once, not inside each operation.',
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
                required: [...OPERATION_REQUIRED_FIELDS],
                additionalProperties: false,
              },
            },
          },
          // `path` is not required: six of 81 audited calls (2026-10-27) named
          // the file inside every operation instead of once here, and were
          // refused for a field the tool can read from the operations it already
          // has. Declaring it required would let `ToolRegistry.invalidArgs` refuse
          // the call before this tool had a chance to lift it.
          required: ['operations'],
          additionalProperties: false,
        },
      },
    },
    permission: 'write',
    // The same lookup the handler uses, so the checkpoint and the diff see the
    // file the call will actually write. Reading only `args.path` here would
    // snapshot nothing for a lifted call, leaving a written file unrecoverable.
    mutation: {
      paths: (args) => {
        const target = callPath(args);
        return target === undefined ? [] : [target];
      },
      showDiff: true,
    },
    handler: async (args, context) => {
      const suppliedPath = callPath(args);
      // Thrown, not returned: `ToolDispatch` prefixes `Error:` and counts a thrown
      // refusal in the consecutive-failure streak that can strip a model's tools.
      // This branch replaced the thrown missing-`path` error, so it must still
      // count as the failure it was.
      if (suppliedPath === undefined) throw new Error(missingPathRefusal(args));
      const liftedFromOperations =
        typeof args['path'] === 'string' && args['path'].trim().length > 0
          ? 0
          : Array.isArray(args['operations'])
            ? args['operations'].length
            : 0;
      const operations = parseOperations(
        liftedFromOperations > 0 ? withoutOperationPaths(args['operations']) : args['operations'],
      );
      const workspaceRoot = defaultWorkspaceRoot();
      const filePath = await resolveRealWorkspacePath(suppliedPath, workspaceRoot, {
        allowMissing: true,
        extraRoots: extraRoots(),
      });
      let content: string;
      let fileState: { size: number; mtimeMs: number; ctimeMs: number };
      try {
        const stat = fs.statSync(filePath);
        fileState = { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
        content = fs.readFileSync(filePath, 'utf8');
        const afterRead = fs.statSync(filePath);
        if (
          afterRead.size !== fileState.size ||
          afterRead.mtimeMs !== fileState.mtimeMs ||
          afterRead.ctimeMs !== fileState.ctimeMs
        ) {
          throw new Error('file changed while it was being read; re-read and retry');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(
            `apply_line_edits: no file at ${filePath} (the path "${suppliedPath}" resolved against the workspace root ${workspaceRoot}). apply_line_edits changes an existing file only: to create it, use write_file; to look for it, use find_files.`,
          );
        }
        throw new Error(`apply_line_edits: cannot read file — ${(error as Error).message}`);
      }
      const result = applyLineEditsToContent(content, operations);
      // Same rule as `edit_file`: a duplicated tips line costs the prompt twice.
      guardTipsWrite(filePath, result.content, content);
      // Snapshot before the write for the same reason `edit_file` does: this tool
      // replaces whole line ranges, so it can delete a line a diagnostic was
      // pointing at and move every problem below it. Awaiting the watcher is what
      // opens the document first, so the service sees this tool's write.
      const watch = await watchProblems(filePath);
      let contentionNote = '';
      await writeFileAtomic(
        filePath,
        result.content,
        agentWriteOptions(context?.abortSignal, { expected: fileState }, (report) => {
          contentionNote = delayedWriteNote(report);
        }),
      );
      // Said so the model knows the tool moved its argument rather than the call
      // having been right, and can put the path where it belongs next time.
      const liftedNote =
        liftedFromOperations > 0
          ? `\nNo "path" at the top level: taken from the operations ("${suppliedPath}").`
          : '';
      // Same honesty for the auto-aligned ranges: the model must know the tool moved its argument,
      // so a corrected call still teaches the right shape next time.
      const alignedNote = result.autoAligned
        .map(
          (a) =>
            `\nNote: operation ${a.index} end_line ${a.statedEnd} did not match its expected_lines ` +
            `count; applied at lines ${a.startLine}-${a.actualEnd} because ` +
            'the text matched exactly at start_line.',
        )
        .join('');
      const note = watch ? await watch.settle(context?.abortSignal) : '';
      return withFileLengthWarning(
        withProblemNote(
          JSON.stringify({
            path: suppliedPath,
            operationsApplied: operations.length,
            replacedLines: result.replacedLines,
            replacementLines: result.replacementLines,
            ...(contentionNote ? { saveNote: contentionNote } : {}),
          }) +
            liftedNote +
            alignedNote +
            tipsWriteNote(filePath),
          note,
        ),
        filePath,
        lengthWarning(),
      );
    },
  };
}

/**
 * The file this call edits: the top-level `path`, or the one path the operations
 * name between them when the top level has none.
 *
 * The lift is safe only because this tool edits one file per call: operations
 * that name different files are a real disagreement and `missingPathRefusal`
 * says so instead of guessing one, while an operation that names none does not
 * disagree with anything — it is silent about a file the other operations already
 * named. Six of 81 audited calls (2026-10-27) put the path inside every
 * operation instead of once at the top, and the call died on a field the tool
 * could read from the arguments it already had.
 */
function callPath(args: Record<string, unknown>): string | undefined {
  const top = args['path'];
  if (typeof top === 'string' && top.trim().length > 0) return top;
  const named = operationPathNames(args['operations']);
  return named.length === 0 || new Set(named).size > 1 ? undefined : named[0];
}

/** Every `path` an operation carries, in order; operations without one are skipped. */
function operationPathNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((operation) => {
    const named =
      operation && typeof operation === 'object' && !Array.isArray(operation)
        ? (operation as Record<string, unknown>)['path']
        : undefined;
    return typeof named === 'string' && named.trim().length > 0 ? [named] : [];
  });
}

/** Copies with `path` removed, so the lifted path has exactly one home. */
function withoutOperationPaths(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((operation) => {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return operation;
    const copy = { ...(operation as Record<string, unknown>) };
    delete copy['path'];
    return copy;
  });
}

/** The refusal for a call with no usable file, naming what it did send. */
function missingPathRefusal(args: Record<string, unknown>): string {
  const distinct = [...new Set(operationPathNames(args['operations']))];
  if (distinct.length > 1) {
    return (
      `apply_line_edits edits one file per call; the operations name ${distinct.length} ` +
      `different files: ${distinct.map((found) => `"${found}"`).join(', ')}. Put one "path" at the ` +
      'top level and resend.'
    );
  }
  return (
    'apply_line_edits is missing required "path". ' +
    'Accepted shape: { "path": "...", "operations": [{ "start_line": 1, "end_line": 2, ' +
    '"expected_lines": ["..."], "replacement_lines": ["..."] }] }. A "path" inside the ' +
    'operations is lifted only when they all name the same file.'
  );
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
    // Distinguish an absent required field from a present wrong-type value:
    // a missing start_line is "missing start_line", not "must be an integer".
    const missing = OPERATION_REQUIRED_FIELDS.find((field) => record[field] === undefined);
    if (missing !== undefined) {
      throw new Error(`apply_line_edits: operation ${index + 1} is missing ${missing}`);
    }
    const expectedLines = requireLines(record['expected_lines'], index, 'expected_lines');
    const hasStart = record['start_line'] !== undefined;
    const hasEnd = record['end_line'] !== undefined;
    if (!hasStart && !hasEnd) {
      throw new Error(`apply_line_edits: operation ${index + 1} is missing start_line or end_line`);
    }
    const suppliedStart = hasStart
      ? requireInteger(record['start_line'], `operation ${index + 1} start_line`)
      : undefined;
    const suppliedEnd = hasEnd
      ? requireInteger(record['end_line'], `operation ${index + 1} end_line`)
      : undefined;
    return {
      start_line: suppliedStart ?? suppliedEnd! - expectedLines.length + 1,
      end_line: suppliedEnd ?? suppliedStart! + expectedLines.length - 1,
      expected_lines: expectedLines,
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
  lines: readonly string[],
): void {
  const lineCount = lines.length;
  if (
    !Number.isInteger(operation.start_line) ||
    !Number.isInteger(operation.end_line) ||
    operation.start_line < 1 ||
    operation.end_line < operation.start_line ||
    operation.end_line > lineCount
  ) {
    // Both lab reps of this refusal (T36) had to re-read the file, because it named neither the
    // file's length nor a range that would have worked. Cheap to state, so state it.
    throw new Error(
      `apply_line_edits: operation ${index + 1} has an out-of-range line span; the file has ` +
        `${lineCount} line(s), so a span must lie within 1-${lineCount}.`,
    );
  }
  const expectedCount = operation.end_line - operation.start_line + 1;
  if (!validLineArray(operation.expected_lines) || !validLineArray(operation.replacement_lines)) {
    throw new Error(`apply_line_edits: operation ${index + 1} contains invalid lines`);
  }
  if (operation.expected_lines.length !== expectedCount) {
    const detail = numberedBlock(lines, operation.start_line, operation.end_line);
    const message =
      `apply_line_edits: operation ${index + 1} expected_lines has ${operation.expected_lines.length} ` +
      `line(s), but lines ${operation.start_line}-${operation.end_line} are ${expectedCount} line(s). ` +
      'expected_lines must be exactly the current text of start_line through end_line, one entry per line.';
    throw new Error(message + capAtLineBoundary(detail, Math.max(0, 1200 - message.length)));
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

/** The corrected `end_line` when an operation's stated span miscounts `expected_lines` but its
 *  text matches the file exactly at the stated `start_line` — a miscount, not a disagreement.
 *  Returns undefined when nothing is corrected: matching only elsewhere is left to the refusal
 *  that names the lines, because which copy was meant is the caller's call, not the tool's. */
function alignedEndLine(
  operation: LineEditOperation,
  lines: readonly string[],
): number | undefined {
  // An empty block matches every slice, and a start below 1 has no meaning — neither is a
  // miscount to correct; both belong to the count refusal below validation.
  if (operation.expected_lines.length === 0 || operation.start_line < 1) return undefined;
  const end = operation.start_line - 1 + operation.expected_lines.length;
  if (end - operation.start_line + 1 === operation.end_line - operation.start_line + 1) {
    return undefined;
  }
  if (end > lines.length) return undefined;
  return sameLines(lines.slice(operation.start_line - 1, end), operation.expected_lines)
    ? end
    : undefined;
}

function requireInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value)) throw new Error(`apply_line_edits: ${field} must be an integer`);
  return value as number;
}
