import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const ledgerPath = path.join(root, 'docs', 'reports', 'BUG_LEDGER.md');

const BUG_HEADER = [
  'ID', 'Sev', 'Status', 'Area', 'What happens', 'Evidence', 'Found', 'Confirmed', 'Fix',
].join(' | ');
const SCORE_HEADER = [
  'Date', 'Run', 'Model', 'Open S1', 'Open S2', 'Open S3', 'Unconfirmed', 'New',
  'Dropped', 'Fixed', 'Notes',
].join(' | ');
const DIVIDER = /^\|[\s:|-]+\|$/;
const REQUIRED_SECTIONS = ['Severity', 'Status', 'Ready line', 'Scoreboard', 'Bugs'];
const BUG_STATUSES = new Set(['unconfirmed', 'open', 'dropped']);
const COUNT_COLUMNS = [3, 4, 5, 6, 7, 8, 9];

const cells = (row: string): string[] => row.slice(1, -1).split('|').map((cell) => cell.trim());

function section(text: string, title: string): string {
  const heading = new RegExp(`^## ${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
  const match = heading.exec(text);
  if (!match) return '';
  const start = (match.index ?? 0) + match[0].length;
  const next = /^## /m.exec(text.slice(start));
  return next ? text.slice(start, start + (next.index ?? 0)) : text.slice(start);
}

function tableRows(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(
    (line) => line.startsWith('|') && line.endsWith('|') && !DIVIDER.test(line),
  );
}

/** Returns actionable format problems, each naming its table row and failed rule. */
function ledgerProblems(text: string): string[] {
  const problems: string[] = [];
  for (const title of REQUIRED_SECTIONS) {
    if (!new RegExp(`^## ${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(text)) {
      problems.push(`section "${title}": required section is missing`);
    }
  }

  const bugs = tableRows(section(text, 'Bugs'));
  const expectedBugHeader = `| ${BUG_HEADER} |`;
  if (bugs[0] !== expectedBugHeader) {
    problems.push(`Bugs header: must be exactly "${BUG_HEADER}"`);
  }
  const bugRows = bugs.slice(1);
  const seenIds = new Set<string>();
  const parsedBugs: string[][] = [];
  for (const [index, row] of bugRows.entries()) {
    const label = `Bugs row ${index + 1}`;
    const values = cells(row);
    if (values.length !== 9) {
      problems.push(`${label}: must have 9 cells (found ${values.length})`);
      continue;
    }
    parsedBugs.push(values);
    if (values.some((value) => value === '')) problems.push(`${label} ${values[0]}: every cell must be non-empty`);
    if (!/^BL-\d{3}$/.test(values[0])) problems.push(`${label} ${values[0]}: ID must match BL-###`);
    if (seenIds.has(values[0])) problems.push(`${label} ${values[0]}: ID must be unique`);
    seenIds.add(values[0]);
    if (!['S1', 'S2', 'S3'].includes(values[1])) problems.push(`${label} ${values[0]}: Sev must be S1, S2, or S3`);
    const isFixed = /^fixed \d+\.\d+\.\d+$/.test(values[2]);
    if (!BUG_STATUSES.has(values[2]) && !isFixed) problems.push(`${label} ${values[0]}: Status is unknown`);
    if (values[2] === 'dropped' && !values[8]) problems.push(`${label} ${values[0]}: dropped row needs a reason in Fix`);
    if ((values[2] === 'open' || isFixed) && values[7] === '—') {
      problems.push(`${label} ${values[0]}: open/fixed row Confirmed must not be —`);
    }
  }

  const scoreboard = tableRows(section(text, 'Scoreboard'));
  const expectedScoreHeader = `| ${SCORE_HEADER} |`;
  if (scoreboard[0] !== expectedScoreHeader) {
    problems.push(`Scoreboard header: must be exactly "${SCORE_HEADER}"`);
  }
  let previousDate = '';
  const scoreRows = scoreboard.slice(1);
  const parsedScoreRows: string[][] = [];
  for (const [index, row] of scoreRows.entries()) {
    const values = cells(row);
    const label = `Scoreboard row ${index + 1}${values[0] ? ` (${values[0]})` : ''}`;
    if (values.length !== 11) {
      problems.push(`${label}: must have 11 cells (found ${values.length})`);
      continue;
    }
    parsedScoreRows.push(values);
    if (values.some((value) => value === '')) problems.push(`${label}: every cell must be non-empty`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(values[0]) || Number.isNaN(Date.parse(`${values[0]}T00:00:00Z`))) {
      problems.push(`${label}: Date must be YYYY-MM-DD`);
    } else {
      if (previousDate && values[0] < previousDate) problems.push(`${label}: Date must not go backwards`);
      previousDate = values[0];
    }
    for (const column of COUNT_COLUMNS) {
      if (!/^\d+$/.test(values[column])) problems.push(`${label}: ${cells(scoreboard[0] ?? '')[column]} must be a non-negative integer`);
    }
  }

  const last = parsedScoreRows.at(-1);
  if (last) {
    const openCounts = ['S1', 'S2', 'S3'].map((severity) =>
      parsedBugs.filter((bug) => bug[2] === 'open' && bug[1] === severity).length,
    );
    const unconfirmed = parsedBugs.filter((bug) => bug[2] === 'unconfirmed').length;
    const expected = [...openCounts, unconfirmed].map(String);
    if (last.slice(3, 7).some((count, index) => count !== expected[index])) {
      problems.push(`Scoreboard row ${scoreRows.length} (${last[0]}): Open S1/S2/S3 and Unconfirmed counts must match the Bugs table`);
    }
  }
  return problems;
}

function sampleLedger(options: { bugRows?: string[]; scoreRows?: string[] } = {}): string {
  const bug = '| BL-001 | S1 | open | core | issue | test.ts:1 | owner 2026-10-24 | Claude 2026-10-24 | fix |';
  const score = '| 2026-10-24 | seed | model | 1 | 0 | 0 | 0 | 1 | 0 | 0 | notes |';
  return [
    '# Ledger', '', '## Severity', 'text', '', '## Status', 'text', '', '## Ready line', 'text',
    '', '## Scoreboard', `| ${SCORE_HEADER} |`, '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|',
    ...(options.scoreRows ?? [score]), '', '## Bugs', `| ${BUG_HEADER} |`,
    '|---|---|---|---|---|---|---|---|---|', ...(options.bugRows ?? [bug]), '',
  ].join('\n');
}

describe('bug ledger format', () => {
  describe.skipIf(!fs.existsSync(ledgerPath))('seeded local ledger', () => {
    it('satisfies the format and scoreboard rules', () => {
      const problems = ledgerProblems(fs.readFileSync(ledgerPath, 'utf8'));
      expect(problems).toEqual([]);
    });
  });

  it('accepts an inline ledger that follows the format', () => {
    expect(ledgerProblems(sampleLedger())).toEqual([]);
  });

  it('reports a missing cell with the row and rule', () => {
    const text = sampleLedger({ bugRows: ['| BL-001 | S1 | open | core | issue | test.ts:1 | owner 2026-10-24 | Claude 2026-10-24 |'] });
    expect(ledgerProblems(text).join('\n')).toContain('Bugs row 1: must have 9 cells');
  });

  it('reports a bad ID', () => {
    const text = sampleLedger({ bugRows: ['| BUG-1 | S1 | open | core | issue | test.ts:1 | owner 2026-10-24 | Claude 2026-10-24 | fix |'] });
    expect(ledgerProblems(text).join('\n')).toContain('Bugs row 1 BUG-1: ID must match BL-###');
  });

  it('reports duplicate IDs', () => {
    const row = '| BL-001 | S1 | open | core | issue | test.ts:1 | owner 2026-10-24 | Claude 2026-10-24 | fix |';
    expect(ledgerProblems(sampleLedger({ bugRows: [row, row] })).join('\n')).toContain('Bugs row 2 BL-001: ID must be unique');
  });

  it('reports an unknown status', () => {
    const row = '| BL-001 | S1 | pending | core | issue | test.ts:1 | owner 2026-10-24 | Claude 2026-10-24 | fix |';
    expect(ledgerProblems(sampleLedger({ bugRows: [row] })).join('\n')).toContain('Bugs row 1 BL-001: Status is unknown');
  });

  it('reports a dropped row without a reason', () => {
    const row = '| BL-001 | S1 | dropped | core | issue | test.ts:1 | owner 2026-10-24 | Claude 2026-10-24 |  |';
    expect(ledgerProblems(sampleLedger({ bugRows: [row], scoreRows: ['| 2026-10-24 | seed | model | 0 | 0 | 0 | 0 | 1 | 1 | 0 | notes |'] })).join('\n'))
      .toContain('Bugs row 1 BL-001: dropped row needs a reason in Fix');
  });

  it('reports an open or fixed row with Confirmed set to —', () => {
    const row = '| BL-001 | S1 | open | core | issue | test.ts:1 | owner 2026-10-24 | — | fix |';
    expect(ledgerProblems(sampleLedger({ bugRows: [row] })).join('\n')).toContain('Bugs row 1 BL-001: open/fixed row Confirmed must not be —');
  });

  it('reports scoreboard counts that disagree with the Bugs table', () => {
    const score = '| 2026-10-24 | seed | model | 0 | 0 | 0 | 0 | 1 | 0 | 0 | notes |';
    expect(ledgerProblems(sampleLedger({ scoreRows: [score] })).join('\n'))
      .toContain('Scoreboard row 1 (2026-10-24): Open S1/S2/S3 and Unconfirmed counts must match the Bugs table');
  });

  it('reports a scoreboard date that goes backwards', () => {
    const scores = [
      '| 2026-10-24 | first | model | 1 | 0 | 0 | 0 | 1 | 0 | 0 | notes |',
      '| 2026-10-23 | second | model | 1 | 0 | 0 | 0 | 1 | 0 | 0 | notes |',
    ];
    expect(ledgerProblems(sampleLedger({ scoreRows: scores })).join('\n'))
      .toContain('Scoreboard row 2 (2026-10-23): Date must not go backwards');
  });
});
