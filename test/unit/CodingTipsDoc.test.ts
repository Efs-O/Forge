/**
 * `docs/CODING_TIPS.md` is the exact-syntax table: one line per mistake, shaped
 * `what I wrote → what happened → what to write instead`, grouped by the action it governs.
 * `FORGE.md` points at it and tells the agent to record a mistake here the moment it fixes one.
 *
 * Its failure mode is bloat and prose: a tips file that reads like guidance is a fourth
 * instruction file, and the fourth one gets skipped. So these tests pin the shape (one line,
 * three parts, no wrapping), the size (small enough to read whole, once a turn), the section
 * names (they must match the pointer in `FORGE.md`), and the rule that general behaviour stays
 * in `config/templates/builtin/execute.njk` while machine facts stay in `FORGE.md` — never
 * restated here.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..', '..');
const docPath = path.join(root, 'docs', 'CODING_TIPS.md');
const doc = fs.readFileSync(docPath, 'utf8');
const lines = doc.split(/\r?\n/);

/** The only section names allowed. A new one goes here first, so the pointer in FORGE.md and
 *  this file cannot drift apart. */
const SECTIONS = ['READ', 'SEARCH', 'EDIT', 'WRITE', 'RUN', 'GIT', 'TEST', 'PATHS', 'DELEGATE', 'FORENSICS'];
const MAX_LINES = 90;
const MAX_PER_SECTION = 25;
const MAX_ENTRY_CHARS = 200;
/** Lines allowed before the first heading: the title and the two rules about duplication. */
const HEADER_BUDGET = 8;

const HEADING = /^## ([A-Z][A-Z_]*)\s*$/;
const ENTRY = /^\d+\.\s/;

const headingLines: { name: string; at: number }[] = [];
lines.forEach((line, i) => {
  const match = line.match(HEADING);
  if (match) headingLines.push({ name: match[1], at: i });
});
const headings = headingLines.map((h) => h.name);
const entries = lines.filter((line) => ENTRY.test(line));

describe('docs/CODING_TIPS.md stays an exact-syntax table', () => {
  it('is committed, not left in the local-only docs pile', () => {
    const tracked = execFileSync('git', ['ls-files', '--error-unmatch', 'docs/CODING_TIPS.md'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(tracked.trim()).toBe('docs/CODING_TIPS.md');
  });

  it('stays small enough to read whole, once a turn', () => {
    expect(lines.length, 'past 90 lines this is a wall again, not a lookup table').toBeLessThanOrEqual(
      MAX_LINES,
    );
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
      const next = headingLines[i + 1] ? headingLines[i + 1].at : lines.length;
      const count = lines
        .slice(headingLines[i].at + 1, next)
        .filter((line) => ENTRY.test(line)).length;
      expect(
        count,
        `section ${headingLines[i].name} outgrew ${MAX_PER_SECTION} lines`,
      ).toBeLessThanOrEqual(MAX_PER_SECTION);
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

  it('is named by the FORGE.md pointer with exactly the sections it has', () => {
    const forgePath = path.join(root, 'FORGE.md');
    if (!fs.existsSync(forgePath)) return; // FORGE.md is gitignored; CI on a fresh clone skips.
    const forge = fs.readFileSync(forgePath, 'utf8');
    const pointer = forge.match(/docs\/CODING_TIPS\.md` is the exact-syntax list: ([A-Z][A-Z_ ]*?)\.\*\*/);
    expect(pointer, 'FORGE.md must point here and name its sections').not.toBeNull();
    const named = (pointer as RegExpMatchArray)[1]
      .split(' ')
      .filter(Boolean)
      .sort();
    expect(named, 'the pointer and the file disagree about which sections exist').toEqual(
      [...headings].sort(),
    );
  });
});
