/**
 * `docs/CODING_TIPS.md` is the single place where mistakes that cost a round are
 * gathered, so an agent can read one section before acting instead of hunting
 * through the instruction file, the traps doc, and the shipped rules template.
 *
 * Its failure mode is the one it replaces: a fourth file nobody reads because it
 * repeats three. These tests pin it as a lookup table — bounded, and explicitly
 * not a copy of `config/templates/builtin/execute.njk`, which is injected every
 * turn and must stay the home of general behaviour rules.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..', '..');
const docPath = path.join(root, 'docs', 'CODING_TIPS.md');
const doc = fs.readFileSync(docPath, 'utf8');

describe('docs/CODING_TIPS.md stays a lookup table', () => {
  it('is committed, not left in the local-only docs pile', () => {
    const tracked = execFileSync('git', ['ls-files', '--error-unmatch', 'docs/CODING_TIPS.md'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(tracked.trim()).toBe('docs/CODING_TIPS.md');
  });

  it('stays short enough to read one section from', () => {
    const lines = doc.split('\n');
    expect(lines.length, 'a tips file that outgrows 220 lines is a wall again').toBeLessThanOrEqual(
      220,
    );
    expect(
      lines.filter((line) => line.startsWith('- ')).length,
      'each tip is one bullet',
    ).toBeLessThanOrEqual(70);
  });

  it('names the shipped rules template as the place general rules belong', () => {
    expect(doc).toContain('config/templates/builtin/execute.njk');
    expect(doc.toLowerCase()).toMatch(/not a second copy|belongs there/);
  });

  it('groups tips by the action they govern, so a section can be read alone', () => {
    const headings = doc
      .split('\n')
      .filter((line) => line.startsWith('## '))
      .map((line) => line.slice(3));
    expect(headings.length, 'sections are action categories, not topics of the day').toBeLessThanOrEqual(
      14,
    );
    for (const required of ['Before acting', 'Editing files', 'Shell and processes', 'Git']) {
      expect(headings, `the section an agent looks for: ${required}`).toContain(required);
    }
  });
});
