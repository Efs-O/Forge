/**
 * The two coding-tips tables are exact-syntax lists: one line per mistake, shaped
 * `what I wrote → what happened → what to write instead`, grouped by the action it governs.
 * `FORGE.md` points at the project one and tells the agent to record a mistake the moment
 * it fixes one; the shipped one is the vendor's copy of the same list.
 *
 * Their failure mode is bloat and prose: a tips file that reads like guidance is a fourth
 * instruction file, and the fourth one gets skipped. So these tests pin the shape (one line,
 * three parts, no wrapping), the size (small enough to read whole, once a turn), the section
 * names (they must match the pointer in `FORGE.md`), and the rule that general behaviour stays
 * in `config/templates/builtin/execute.njk` while machine facts stay in `FORGE.md` — never
 * restated here.
 *
 * Rows under `## FORGE_TOOLS` are the exception to the per-section cap: they leave the table
 * at request time and are appended to the description of the tool each row names, so they are
 * capped per tool instead (`TOOL_TIPS_MAX_PER_TOOL` in `src/llm/toolTips.ts`).
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import {
  PROJECT_TIPS_ALLOWANCE,
  SHIPPED_TIPS_ALLOWANCE,
  TIPS_ENTRY_MAX_CHARS,
  TIPS_TABLE_MAX_LINES,
} from '../../src/llm/codingTipsBudget';
import { TOOL_TIPS_MAX_PER_TOOL } from '../../src/llm/toolTips';
import { withoutReviewedMark } from '../../src/llm/tipsReviewed';

const root = path.resolve(__dirname, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

/** The two tables, each with the allowance its loader clamps it to. */
const TABLES: ReadonlyArray<readonly [string, number]> = [
  ['docs/CODING_TIPS.md', PROJECT_TIPS_ALLOWANCE],
  ['resources/tips/CODING_TIPS.md', SHIPPED_TIPS_ALLOWANCE],
];

/** The only section names allowed. A new one goes here first, so the pointer in FORGE.md and
 *  this file cannot drift apart. */
const SECTIONS = [
  'READ',
  'SEARCH',
  'EDIT',
  'WRITE',
  'RUN',
  'GIT',
  'TEST',
  'PATHS',
  'DELEGATE',
  'FORENSICS',
  'FORGE_TOOLS',
];
/** Doubled from 90 on 2026-11-14: the table reached its cap on the day the cap was
 *  meant to be a safety net, not a wall. The byte allowances in `codingTips.ts` are
 *  raised with it — a cap the loader truncates under is not a cap, it is a lie. */
const MAX_LINES = TIPS_TABLE_MAX_LINES;
const MAX_PER_SECTION = 25;
const MAX_ENTRY_CHARS = TIPS_ENTRY_MAX_CHARS;
/** Lines allowed before the first heading: the title and the two rules about duplication. */
const HEADER_BUDGET = 8;

const HEADING = /^## ([A-Z][A-Z_]*)\s*$/;
const ENTRY = /^\d+\.\s/;
/** A Forge-tool row: the numbered prefix, the tool's name in backticks, ` · `, the tip. */
const TOOL_ROW = /^\d+\. `([a-z][a-z0-9_]*)` \u00B7 \S/;

/** Parse one table, as the prompt gets it (no review mark), into the parts to check. */
function parseTable(text: string) {
  const lines = withoutReviewedMark(text).split(/\r?\n/);
  const headingLines: { name: string; at: number }[] = [];
  lines.forEach((line, i) => {
    const match = line.match(HEADING);
    if (match) headingLines.push({ name: match[1], at: i });
  });
  return {
    lines,
    headingLines,
    headings: headingLines.map((h) => h.name),
    entries: lines.filter((line) => ENTRY.test(line)),
  };
}

const docRel = 'docs/CODING_TIPS.md';
const doc = read(docRel);
const docTable = parseTable(doc);

describe.each(TABLES)('%s stays an exact-syntax table', (rel, allowance) => {
  const { lines, headingLines, headings, entries } = parseTable(read(rel));

  it('is committed, not left in the local-only docs pile', () => {
    const tracked = execFileSync('git', ['ls-files', '--error-unmatch', rel], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(tracked.trim()).toBe(rel);
  });

  it('stays small enough to read whole, once a turn', () => {
    expect(
      lines.length,
      `past ${MAX_LINES} lines this is a wall again, not a lookup table`,
    ).toBeLessThanOrEqual(MAX_LINES);
  });

  it('fits the loader whole: the shape the test allows is never truncated', () => {
    // Every line a full entry plus its newline, in UTF-8 bytes at 1.1 per char.
    const largestLegalTable = Math.ceil(MAX_LINES * (MAX_ENTRY_CHARS + 1) * 1.1);
    expect(largestLegalTable).toBeLessThanOrEqual(PROJECT_TIPS_ALLOWANCE);
    expect(largestLegalTable).toBeLessThanOrEqual(SHIPPED_TIPS_ALLOWANCE);
    expect(Buffer.byteLength(read(rel), 'utf8')).toBeLessThanOrEqual(allowance);
  });

  it('groups by the action the mistake belongs to', () => {
    expect(headings.length, 'the table needs at least one section').toBeGreaterThan(0);
    for (const heading of headings) {
      expect(SECTIONS, `section ${heading} is not one of the action categories`).toContain(heading);
    }
    expect(new Set(headings).size, 'each section appears once').toBe(headings.length);
  });

  it('keeps each section short enough to scan', () => {
    for (let i = 0; i < headingLines.length; i++) {
      const section = headingLines[i] as { name: string; at: number };
      // Forge-tool rows are capped per tool, in the next test: they are not scanned here.
      if (section.name === 'FORGE_TOOLS') continue;
      const next = headingLines[i + 1] ? headingLines[i + 1]!.at : lines.length;
      const count = lines.slice(section.at + 1, next).filter((line) => ENTRY.test(line)).length;
      expect(count, `section ${section.name} outgrew ${MAX_PER_SECTION} lines`).toBeLessThanOrEqual(
        MAX_PER_SECTION,
      );
    }
  });

  it('writes every entry as wrong → happened → right, on one line', () => {
    for (const entry of entries) {
      expect(entry, 'an entry names what happens, so it needs the arrow').toContain('→');
      expect(
        entry.length,
        'one line per tip: a wrapped entry cannot be counted',
      ).toBeLessThanOrEqual(MAX_ENTRY_CHARS);
    }
    expect(entries.length, 'a table with no entries is a header').toBeGreaterThan(0);
  });

  it('holds no prose: after the first heading, only headings, entries and blanks', () => {
    const firstHeading = lines.findIndex((line) => HEADING.test(line));
    const stray = lines
      .slice(firstHeading + 1)
      .map((line, i) => ({ line, n: firstHeading + 2 + i }))
      .filter(({ line }) => line.trim() !== '' && !HEADING.test(line) && !ENTRY.test(line));
    expect(
      stray.map(({ n, line }) => `${n}: ${line}`),
      'guidance belongs in execute.njk, history in the commit message — not here',
    ).toEqual([]);
  });

  it('says where general rules and machine facts belong instead', () => {
    const firstHeading = lines.findIndex((line) => HEADING.test(line));
    const header = lines.slice(0, firstHeading).join('\n');
    expect(
      lines.slice(0, firstHeading).filter((line) => line.trim() !== '').length,
      `the header is over ${HEADER_BUDGET} lines of prose`,
    ).toBeLessThanOrEqual(HEADER_BUDGET);
    expect(header, 'the no-duplicates rule names the shipped template').toContain(
      'config/templates/builtin/execute.njk',
    );
    expect(header.toLowerCase(), 'machine facts go to FORGE.md, not here').toContain('forge.md');
  });

  it('names every Forge-tool row with the tool it belongs to', () => {
    const at = headingLines.findIndex((h) => h.name === 'FORGE_TOOLS');
    if (at === -1) return; // a table with no Forge-tool rows.
    const section = headingLines[at] as { name: string; at: number };
    const end = headingLines[at + 1] ? headingLines[at + 1]!.at : lines.length;
    const rows = lines.slice(section.at + 1, end).filter((line) => ENTRY.test(line));
    const perTool = new Map<string, number>();
    for (const row of rows) {
      const match = TOOL_ROW.exec(row);
      expect(
        match,
        `${rel}: a FORGE_TOOLS row must read "1. \`tool_name\` · tip" — got ${row.slice(0, 60)}`,
      ).not.toBeNull();
      const name = (match as RegExpExecArray)[1] as string;
      perTool.set(name, (perTool.get(name) ?? 0) + 1);
    }
    for (const [name, count] of perTool) {
      expect(
        count,
        `${rel}: ${name} has ${count} rows, and a tool's description carries at most ${TOOL_TIPS_MAX_PER_TOOL}`,
      ).toBeLessThanOrEqual(TOOL_TIPS_MAX_PER_TOOL);
    }
  });
});

describe(docRel, () => {
  it('is named by the FORGE.md pointer with exactly the sections it has', () => {
    const forgePath = path.join(root, 'FORGE.md');
    if (!fs.existsSync(forgePath)) return; // FORGE.md is gitignored; CI on a fresh clone skips.
    const forge = fs.readFileSync(forgePath, 'utf8');
    const pointer = forge.match(
      /docs\/CODING_TIPS\.md` is the exact-syntax list: ([A-Z][A-Z_ ]*?)\.\*\*/,
    );
    expect(pointer, 'FORGE.md must point here and name its sections').not.toBeNull();
    const named = (pointer as RegExpMatchArray)[1].split(' ').filter(Boolean).sort();
    expect(named, 'the pointer and the file disagree about which sections exist').toEqual(
      [...docTable.headings].sort(),
    );
  });
});
