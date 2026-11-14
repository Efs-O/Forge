/**
 * Phase 5 of INSTRUCTION_AND_TOOL_TEXT_STREAMLINE_PLAN.md: the project tips table
 * is injected into every prompt, so the write path has to keep it honest — one
 * copy of a line, and a count that tells the agent when to hand the list back.
 *
 * The rules live in `src/tools/tipsWriteGuard.ts`; the three tools that can write
 * the file call it on the bytes they are about to save. The wiring is proven in
 * `test/integration/FileToolExecution.test.ts`, which owns the tool harness.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  guardTipsWrite,
  isProjectTipsPath,
  tipsWriteNote,
  tipsWriteRefusal,
} from '../../src/tools/tipsWriteGuard';

const SHIPPED = '## EDIT\n1. an existing tip → already reviewed\n';
const PROJECT = '## EDIT\n1. a project tip → recorded here\n';

let dir = '';
let shippedPath = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tips-guard-'));
  shippedPath = path.join(dir, 'shipped.md');
  fs.writeFileSync(shippedPath, SHIPPED, 'utf8');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('the tips write guard speaks only for the project table', () => {
  it('matches the tips path in either slash style, and nothing else', () => {
    expect(isProjectTipsPath('N:/repo/docs/CODING_TIPS.md')).toBe(true);
    expect(isProjectTipsPath('N:\\repo\\docs\\coding_tips.md')).toBe(true);
    expect(isProjectTipsPath('N:/repo/docs/TOOL_TRAPS.md')).toBe(false);
    expect(() => guardTipsWrite('N:/repo/src/a.ts', '1. x → one\n1. x → one\n', '')).not.toThrow();
  });
});

describe('an exact duplicate is refused before anything is written', () => {
  it('catches a second copy of a line the file already holds', () => {
    const refusal = tipsWriteRefusal({
      proposed: `${PROJECT.trim()}\n1. a project tip → recorded here\n`,
      previous: PROJECT,
      shippedPath,
    });
    expect(refusal).toContain('already carries this tip');
    expect(refusal).toContain('a project tip');
  });

  it('catches a copy of a line the shipped table already injects', () => {
    expect(
      tipsWriteRefusal({
        proposed: `## EDIT\n1. an existing tip → already reviewed\n`,
        previous: '',
        shippedPath,
      }),
    ).toContain('already carries this tip');
  });

  it('catches a re-wrapped or re-cased copy, because it is the same tip', () => {
    expect(
      tipsWriteRefusal({
        proposed: `## EDIT\n1. A   PROJECT   TIP → RECORDED    HERE\n1. a project tip → recorded here\n`,
        previous: PROJECT,
        shippedPath,
      }),
    ).toContain('already carries this tip');
  });

  it('accepts a genuinely new line', () => {
    expect(
      tipsWriteRefusal({
        proposed: `${PROJECT.trim()}\n1. a new tip → noticed now\n`,
        previous: PROJECT,
        shippedPath,
      }),
    ).toBeUndefined();
  });

  it('does not blame an unrelated edit for a duplicate that was already on file', () => {
    const duplicated = `## EDIT\n1. old → one\n1. old → one\n`;
    expect(
      tipsWriteRefusal({
        proposed: `${duplicated.trim()}\n1. new → two\n`,
        previous: duplicated,
        shippedPath,
      }),
    ).toBeUndefined();
  });

  it('throws, so the tool reports a refusal and writes nothing', () => {
    expect(() =>
      guardTipsWrite(
        'N:/repo/docs/CODING_TIPS.md',
        `${PROJECT.trim()}\n1. a project tip → recorded here\n`,
        PROJECT,
        shippedPath,
      ),
    ).toThrow(/No changes were written/);
  });
});

describe('the count and the every-tenth review ping', () => {
  const fileIn = (entries: number): string => {
    const file = path.join(dir, 'docs', 'CODING_TIPS.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = Array.from(
      { length: entries },
      (_, i) => `${i + 1}. tip ${i + 1} → mistake ${i + 1}`,
    );
    fs.writeFileSync(file, `## EDIT\n${body.join('\n')}\n`, 'utf8');
    return file;
  };

  it('says how many entries the shipped list does not have', () => {
    expect(tipsWriteNote(fileIn(1), shippedPath)).toContain('1 entry in docs/CODING_TIPS.md');
    expect(tipsWriteNote(fileIn(9), shippedPath)).toContain('9 entries in docs/CODING_TIPS.md');
  });

  it('asks for a review at ten, and not again at eleven', () => {
    expect(tipsWriteNote(fileIn(9), shippedPath)).not.toContain('tell the owner now');
    expect(tipsWriteNote(fileIn(10), shippedPath)).toContain('tell the owner now');
    expect(tipsWriteNote(fileIn(11), shippedPath)).not.toContain('tell the owner now');
    expect(tipsWriteNote(fileIn(20), shippedPath)).toContain('tell the owner now');
  });

  it('says nothing when the project table holds nothing the shipped one does not', () => {
    const file = path.join(dir, 'docs', 'CODING_TIPS.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, SHIPPED, 'utf8');
    expect(tipsWriteNote(file, shippedPath)).toBe('');
  });

  it('says nothing for any other file', () => {
    expect(tipsWriteNote(path.join(dir, 'notes.md'), shippedPath)).toBe('');
  });
});
