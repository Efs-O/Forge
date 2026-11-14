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

  it('catches the same tip added under a different number — the usual duplicate', () => {
    // Entries are numbered per section, so the key must ignore the number: an
    // agent appends the shipped tip as `4.` and nothing else about it changes.
    expect(
      tipsWriteRefusal({
        proposed: `## EDIT\n1. an existing tip → already reviewed\n4. an existing tip → already reviewed\n`,
        previous: `## EDIT\n1. an existing tip → already reviewed\n`,
        shippedPath,
      }),
    ).toContain('already carries this tip');
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
  // Resolved per call, never at collection time: a describe-level const runs
  // while `dir` is still '', and path.join('', 'docs', 'CODING_TIPS.md') is a
  // RELATIVE path — that wrote the fixture over the repo's own tips table.
  const file = (): string => path.join(dir, 'docs', 'CODING_TIPS.md');
  const writeEntries = (entries: number): string => {
    const body = Array.from(
      { length: entries },
      (_, i) => `${i + 1}. tip ${i + 1} → mistake ${i + 1}`,
    ).join('\n');
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), `## EDIT\n${body}\n`, 'utf8');
    return `## EDIT\n${body}\n`;
  };

  it('says how many entries the shipped list does not have', () => {
    const one = writeEntries(1);
    expect(tipsWriteNote(file(), one, shippedPath)).toContain('1 entry in docs/CODING_TIPS.md');
    const nine = writeEntries(9);
    expect(tipsWriteNote(file(), nine, shippedPath)).toContain('9 entries in docs/CODING_TIPS.md');
  });

  it('pings on the crossing of a tenth, once — not on every write that sits at one', () => {
    const nine = writeEntries(9);
    expect(tipsWriteNote(file(), nine, shippedPath)).not.toContain('tell the owner now');
    const ten = writeEntries(10);
    expect(tipsWriteNote(file(), nine, shippedPath)).toContain('tell the owner now');
    // A re-word while the count sits at 10 stays quiet: nothing crossed.
    expect(tipsWriteNote(file(), ten, shippedPath)).not.toContain('tell the owner now');
    expect(tipsWriteNote(file(), writeEntries(11), shippedPath)).not.toContain('tell the owner now');
    // A write that adds two tips across the boundary still fires, exactly once.
    const nineAgain = writeEntries(9);
    writeEntries(11);
    expect(tipsWriteNote(file(), nineAgain, shippedPath)).toContain('tell the owner now');
    const nineteen = writeEntries(19);
    writeEntries(20);
    expect(tipsWriteNote(file(), nineteen, shippedPath)).toContain('tell the owner now');
    expect(ten.length).toBeGreaterThan(0);
  });

  it('says nothing when the project table holds nothing the shipped one does not', () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), SHIPPED, 'utf8');
    expect(tipsWriteNote(file(), SHIPPED, shippedPath)).toBe('');
  });

  it('says nothing for any other file', () => {
    expect(tipsWriteNote(path.join(dir, 'notes.md'), '', shippedPath)).toBe('');
  });
});
