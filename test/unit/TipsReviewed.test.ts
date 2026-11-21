/**
 * The tips review mark (`src/llm/tipsReviewed.ts`): a reviewed keeper in
 * docs/CODING_TIPS.md stops counting toward the every-tenth "Tips review due"
 * ping, a reworded one counts again, and the mark never reaches a prompt.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearCodingTipsCache, loadCodingTips } from '../../src/llm/codingTips';
import {
  markProjectTipsReviewed,
  reviewedTipHashes,
  tipEntryKey,
  tipHash,
  withoutReviewedMark,
} from '../../src/llm/tipsReviewed';
import { tipsWriteNote } from '../../src/tools/tipsWriteGuard';

const SHIPPED = '## EDIT\n1. a shipped tip → already reviewed\n';

let dir = '';
const projectFile = (): string => path.join(dir, 'docs', 'CODING_TIPS.md');
const shippedFile = (): string => path.join(dir, 'resources', 'tips', 'CODING_TIPS.md');
const tips = (from: number, to: number): string =>
  Array.from({ length: to - from + 1 }, (_, i) => `${i + 1}. tip ${from + i} → mistake`).join('\n');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tips-reviewed-'));
  fs.mkdirSync(path.dirname(projectFile()), { recursive: true });
  fs.mkdirSync(path.dirname(shippedFile()), { recursive: true });
  fs.writeFileSync(shippedFile(), SHIPPED, 'utf8');
  clearCodingTipsCache();
});
afterEach(() => {
  clearCodingTipsCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the review mark', () => {
  it('marks the kept tips and leaves out the ones the shipped table has', () => {
    const marked = markProjectTipsReviewed(
      '# Tips\n\n## EDIT\n1. a kept tip → stays\n2. a shipped tip → already reviewed\n',
      SHIPPED,
    );
    expect(marked).toBe(
      `# Tips\n\n## EDIT\n1. a kept tip → stays\n2. a shipped tip → already reviewed\n\n` +
        `<!-- tips reviewed: ${tipHash(tipEntryKey('1. a kept tip → stays'))} -->\n`,
    );
    // Marking again replaces the line rather than adding a second one.
    expect(markProjectTipsReviewed(marked, SHIPPED)).toBe(marked);
  });

  it('reads no hashes from a file without a mark', () => {
    expect(reviewedTipHashes('## EDIT\n1. a → b\n').size).toBe(0);
  });

  it('is stripped before the table reaches a prompt', () => {
    const body = `## EDIT\n${tips(1, 3)}\n`;
    fs.writeFileSync(projectFile(), markProjectTipsReviewed(body, SHIPPED), 'utf8');
    const block = loadCodingTips(dir, shippedFile())?.text;
    expect(block).toContain('tip 3 → mistake');
    expect(block).not.toContain('tips reviewed');
    expect(withoutReviewedMark(markProjectTipsReviewed(body, SHIPPED))).toBe(body.trimEnd());
  });
});

describe('the review ping counts only tips added since the review', () => {
  const ping = 'Tips review due';

  it('stays quiet when a reviewed list grows past the next tenth by keepers alone', () => {
    // 47 kept tips, reviewed; three new ones would cross 50 under the old count.
    const reviewed = markProjectTipsReviewed(`## EDIT\n${tips(1, 47)}\n`, SHIPPED);
    const grown = reviewed.replace(
      '\n\n<!--',
      `\n48. tip 48 → mistake\n49. tip 49 → mistake\n50. tip 50 → mistake\n\n<!--`,
    );
    fs.writeFileSync(projectFile(), grown, 'utf8');
    const note = tipsWriteNote(projectFile(), reviewed, shippedFile(), dir);
    expect(note).toBe(
      '\nProject tips: 3 entries in docs/CODING_TIPS.md are not in the shipped table and not yet reviewed.',
    );
  });

  it('pings when the tips added since the review reach ten', () => {
    const reviewed = markProjectTipsReviewed(`## EDIT\n${tips(1, 47)}\n`, SHIPPED);
    const withNine = reviewed.replace('\n\n<!--', `\n${tips(48, 56)}\n\n<!--`);
    const withTen = reviewed.replace('\n\n<!--', `\n${tips(48, 57)}\n\n<!--`);
    fs.writeFileSync(projectFile(), withTen, 'utf8');
    expect(tipsWriteNote(projectFile(), withNine, shippedFile(), dir)).toContain(ping);
  });

  it('counts a reworded keeper as new: its text is not what was reviewed', () => {
    const reviewed = markProjectTipsReviewed(`## EDIT\n${tips(1, 5)}\n`, SHIPPED);
    fs.writeFileSync(
      projectFile(),
      reviewed.replace('tip 2 → mistake', 'tip 2 → a sharper mistake'),
      'utf8',
    );
    expect(tipsWriteNote(projectFile(), reviewed, shippedFile(), dir)).toBe(
      '\nProject tips: 1 entry in docs/CODING_TIPS.md is not in the shipped table and not yet reviewed.',
    );
  });
});

describe('scripts/mark-tips-reviewed.mjs', () => {
  it('writes the mark into the project file of the root it is given', () => {
    fs.writeFileSync(projectFile(), `## EDIT\n${tips(1, 2)}\n`, 'utf8');
    const out = execFileSync(
      process.execPath,
      [path.resolve('scripts/mark-tips-reviewed.mjs'), dir],
      {
        encoding: 'utf8',
      },
    );
    expect(out.trim()).toBe(
      'mark-tips-reviewed: 2 project tips marked reviewed in docs/CODING_TIPS.md',
    );
    expect(reviewedTipHashes(fs.readFileSync(projectFile(), 'utf8')).size).toBe(2);
  });
});
