/**
 * CLAUDE.md "Plan Docs": a plan whose feature writes durable state carries a
 * "State × lifecycle ledger" with every cell filled. The rule existed, and the
 * 2026-09-21 audit still found four defects (A2, A3, A4, A7) in cells nobody
 * wrote — the Telegram contact plan had no ledger at all. Prose did not carry
 * the obligation; this test does.
 *
 * Every plan in docs/plans/ must have a ledger section. A plan with nothing
 * durable says so inside that section ("no durable state"), so the absence of
 * state is a decision someone wrote down, not a section someone forgot.
 * Plans written before this check are listed in plan-ledger-baseline.json; the
 * list may only shrink.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const plansDir = path.join(root, 'docs', 'plans');
const baseline = JSON.parse(
  fs.readFileSync(path.join(root, 'test', 'fixtures', 'plan-ledger-baseline.json'), 'utf8'),
) as string[];

const HEADING = /^(#{2,4})[^\n]*State\s*×\s*lifecycle ledger[^\n]*$/gim;
const NO_STATE = /no (new )?durable state/i;
const DIVIDER = /^\|[\s:|-]+\|$/;

const plans = fs
  .readdirSync(plansDir)
  .filter((name) => name.endsWith('.md'))
  .sort();

/** The body of each ledger section: up to the next heading of the same or higher level. */
function ledgerSections(text: string): string[] {
  return Array.from(text.matchAll(HEADING), (match) => {
    const rest = text.slice((match.index ?? 0) + match[0].length);
    const next = new RegExp(`^#{1,${match[1].length}} `, 'm').exec(rest);
    return next ? rest.slice(0, next.index) : rest;
  });
}

const cells = (row: string): string[] =>
  row
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());

/** Problems in one ledger section; empty when it is a filled table or a no-state declaration. */
function sectionProblems(section: string): string[] {
  const rows = section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && line.endsWith('|') && !DIVIDER.test(line));
  if (rows.length === 0) {
    return NO_STATE.test(section) ? [] : ['has no table and does not say "no durable state"'];
  }
  const width = cells(rows[0]!).length;
  return rows.slice(1).flatMap((row) => {
    const values = cells(row);
    if (values.length !== width)
      return [`row has ${values.length} cells, header has ${width}: ${row}`];
    return values.includes('') ? [`row has an empty cell: ${row}`] : [];
  });
}

describe('plan docs carry a state × lifecycle ledger', () => {
  it('every plan written after the baseline has a ledger section', () => {
    const missing = plans.filter(
      (name) =>
        !baseline.includes(name) &&
        ledgerSections(fs.readFileSync(path.join(plansDir, name), 'utf8')).length === 0,
    );
    expect(missing, 'add a "## State × lifecycle ledger" section (see CLAUDE.md)').toEqual([]);
  });

  it('every ledger is a filled table or an explicit no-durable-state declaration', () => {
    const problems = plans.flatMap((name) =>
      ledgerSections(fs.readFileSync(path.join(plansDir, name), 'utf8')).flatMap((section) =>
        sectionProblems(section).map((problem) => `${name}: ${problem}`),
      ),
    );
    expect(problems).toEqual([]);
  });

  it('the baseline only shrinks: a plan that gained a ledger leaves it', () => {
    const fixed = baseline.filter((name) => {
      const file = path.join(plansDir, name);
      return fs.existsSync(file) && ledgerSections(fs.readFileSync(file, 'utf8')).length > 0;
    });
    expect(fixed, 'remove these from test/fixtures/plan-ledger-baseline.json').toEqual([]);
  });

  it('judges a section the way the rule reads', () => {
    const table = '\n| artifact | create | delete |\n|---|---|---|\n| lease | a | b |\n';
    expect(sectionProblems(table)).toEqual([]);
    expect(sectionProblems(table.replace('| b |', '|  |'))).toHaveLength(1);
    expect(sectionProblems(table.replace('| a | b |', '| a |'))).toHaveLength(1);
    expect(sectionProblems('\nThis fix writes no new durable state.\n')).toEqual([]);
    expect(sectionProblems('\nTBD\n')).toHaveLength(1);
  });
});
