/**
 * Phase 5 of INSTRUCTION_AND_TOOL_TEXT_STREAMLINE_PLAN.md: the project tips table
 * is injected into every prompt, so the write path has to keep it honest — one
 * copy of a line, and a count that tells the agent when to hand the list back.
 *
 * The rules live in `src/tools/tipsWriteGuard.ts`; the three tools that can write
 * the file call it on the bytes they are about to save. The wiring is proven in
 * `test/integration/FileToolExecution.test.ts`, which owns the tool harness.
 *
 * Phase 3 of CODING_TIPS_IN_TOOLS_PLAN.md adds the second table: in Forge's own
 * repository (`package.json` name `forge-llm`) the shipped table
 * `resources/tips/CODING_TIPS.md` is guarded too, so a promotion is a move.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  guardTipsWrite,
  isProjectTipsPath,
  isShippedTipsPath,
  shippedTipsWriteRefusal,
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
  it('matches the tips file of the open workspace, in either slash style', () => {
    expect(isProjectTipsPath('N:/x/Forge/docs/CODING_TIPS.md', 'N:/x/Forge')).toBe(true);
    if (process.platform === 'win32') {
      expect(isProjectTipsPath('N:\\x\\Forge\\docs\\coding_tips.md', 'N:\\x\\Forge')).toBe(true);
    }
    expect(isProjectTipsPath('N:/x/Forge/docs/TOOL_TRAPS.md', 'N:/x/Forge')).toBe(false);
    // A root spelled with a trailing separator is the same root.
    expect(isProjectTipsPath('N:/x/Forge/docs/CODING_TIPS.md', 'N:/x/Forge/')).toBe(true);
    expect(() =>
      guardTipsWrite('N:/x/Forge/src/a.ts', '1. x → one\n1. x → one\n', ''),
    ).not.toThrow();
  });

  it('is not the project table when the path only looks like it', () => {
    const root = 'N:/x/Forge';
    // A folder whose name merely ENDS in `docs`, and a nested repository's own
    // table: neither is the file every prompt injects.
    expect(isProjectTipsPath('N:/x/Forge/mydocs/coding_tips.md', root)).toBe(false);
    expect(isProjectTipsPath('N:/x/Forge/sub/docs/CODING_TIPS.md', root)).toBe(false);
    expect(isProjectTipsPath('N:/x/Other/docs/CODING_TIPS.md', root)).toBe(false);
  });

  it('guards nothing while no workspace folder is open', () => {
    expect(isProjectTipsPath('N:/x/Forge/docs/CODING_TIPS.md', undefined)).toBe(false);
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
        'N:/repo',
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
    expect(tipsWriteNote(file(), one, shippedPath, dir)).toContain(
      '1 entry in docs/CODING_TIPS.md is not in the shipped table',
    );
    const nine = writeEntries(9);
    expect(tipsWriteNote(file(), nine, shippedPath, dir)).toContain(
      '9 entries in docs/CODING_TIPS.md are not in the shipped table',
    );
  });

  it('pings on the crossing of a tenth, once — not on every write that sits at one', () => {
    const nine = writeEntries(9);
    expect(tipsWriteNote(file(), nine, shippedPath, dir)).not.toContain('tell the owner now');
    const ten = writeEntries(10);
    expect(tipsWriteNote(file(), nine, shippedPath, dir)).toContain('tell the owner now');
    // A re-word while the count sits at 10 stays quiet: nothing crossed.
    expect(tipsWriteNote(file(), ten, shippedPath, dir)).not.toContain('tell the owner now');
    expect(tipsWriteNote(file(), writeEntries(11), shippedPath, dir)).not.toContain(
      'tell the owner now',
    );
    // A write that adds two tips across the boundary still fires, exactly once.
    const nineAgain = writeEntries(9);
    writeEntries(11);
    expect(tipsWriteNote(file(), nineAgain, shippedPath, dir)).toContain('tell the owner now');
    const nineteen = writeEntries(19);
    writeEntries(20);
    expect(tipsWriteNote(file(), nineteen, shippedPath, dir)).toContain('tell the owner now');
    expect(ten.length).toBeGreaterThan(0);
  });

  it('says nothing when the project table holds nothing the shipped one does not', () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), SHIPPED, 'utf8');
    expect(tipsWriteNote(file(), SHIPPED, shippedPath, dir)).toBe('');
  });

  it('says nothing for any other file', () => {
    expect(tipsWriteNote(path.join(dir, 'notes.md'), '', shippedPath, dir)).toBe('');
  });

  it("says nothing for a table one folder deeper, which is not this workspace's", () => {
    writeEntries(1);
    expect(
      tipsWriteNote(path.join(dir, 'sub', 'docs', 'CODING_TIPS.md'), '', shippedPath, dir),
    ).toBe('');
  });
});

/**
 * Phase 3: in this repository the shipped table is a file the agent can edit, so
 * the duplicate rule has to run on it too — otherwise a promotion leaves the same
 * tip in both tables, and the prompt pays for it twice.
 *
 * `shippedPath` is left undefined throughout: that is what makes the guard read
 * the workspace's own shipped file instead of the installed fixture.
 */
describe("in Forge's own repository, both tables are guarded", () => {
  const SHIPPED_HERE = '## EDIT\n1. a shipped tip → already reviewed\n';
  const ws = (): string => path.join(dir, 'forge');
  const shippedFile = (): string => path.join(ws(), 'resources', 'tips', 'CODING_TIPS.md');
  const projectFile = (): string => path.join(ws(), 'docs', 'CODING_TIPS.md');

  const makeForgeWorkspace = (pkgName: string): void => {
    fs.mkdirSync(path.dirname(shippedFile()), { recursive: true });
    fs.mkdirSync(path.dirname(projectFile()), { recursive: true });
    fs.writeFileSync(path.join(ws(), 'package.json'), `{"name":"${pkgName}"}`, 'utf8');
    fs.writeFileSync(shippedFile(), SHIPPED_HERE, 'utf8');
    fs.writeFileSync(projectFile(), PROJECT, 'utf8');
  };

  it('recognises the shipped table only in a forge-llm workspace', () => {
    makeForgeWorkspace('forge-llm');
    expect(isShippedTipsPath(shippedFile(), ws())).toBe(true);
    expect(isShippedTipsPath(path.join(ws(), 'resources', 'CODING_TIPS.md'), ws())).toBe(false);
    makeForgeWorkspace('my-app');
    expect(isShippedTipsPath(shippedFile(), ws())).toBe(false);
  });

  it('refuses a project-list line that the workspace shipped file already holds', () => {
    makeForgeWorkspace('forge-llm');
    expect(
      () => {
        guardTipsWrite(
          projectFile(),
          `${PROJECT.trim()}\n2. a shipped tip → already reviewed\n`,
          PROJECT,
          undefined,
          ws(),
        );
      },
      // The workspace copy, not the installed fixture, is what it was checked against.
    ).toThrow('docs/CODING_TIPS.md already carries this tip');
  });

  it('refuses a shipped line the project list still holds, and says where it lives', () => {
    makeForgeWorkspace('forge-llm');
    const proposed = `${SHIPPED_HERE.trim()}\n2. a project tip → recorded here\n`;
    const refusal =
      'that line is still in docs/CODING_TIPS.md: delete it there first, ' +
      'then add it here: "2. a project tip → recorded here"';
    expect(() => {
      guardTipsWrite(shippedFile(), proposed, SHIPPED_HERE, undefined, ws());
    }).toThrow(new Error(`${refusal} No changes were written.`));
  });

  it('refuses a second copy of a line the shipped file already carries', () => {
    makeForgeWorkspace('forge-llm');
    const proposed = `${SHIPPED_HERE.trim()}\n2. a shipped tip → already reviewed\n`;
    expect(
      () => {
        guardTipsWrite(shippedFile(), proposed, SHIPPED_HERE, undefined, ws());
      },
      // The same tip under another number is still the same tip.
    ).toThrow(
      'resources/tips/CODING_TIPS.md already carries this tip: ' +
        '"1. a shipped tip → already reviewed" — sharpen that line instead of adding a copy.',
    );
  });

  it('allows a genuinely new line in either table', () => {
    makeForgeWorkspace('forge-llm');
    expect(() => {
      guardTipsWrite(
        projectFile(),
        `${PROJECT.trim()}\n2. a new tip → recorded now\n`,
        PROJECT,
        undefined,
        ws(),
      );
    }).not.toThrow();
    expect(() => {
      guardTipsWrite(
        shippedFile(),
        `${SHIPPED_HERE.trim()}\n2. a new tip → reviewed now\n`,
        SHIPPED_HERE,
        undefined,
        ws(),
      );
    }).not.toThrow();
  });

  it('allows a promotion done in order: out of the project list, then into the shipped file', () => {
    makeForgeWorkspace('forge-llm');
    const without = '## EDIT\n1. another tip → stays put\n';
    expect(() => {
      guardTipsWrite(projectFile(), without, PROJECT, undefined, ws());
    }).not.toThrow();
    // The guard only validates: the promotion is a move once the first file is
    // actually on disk without the line, which is what the writer does next.
    fs.writeFileSync(projectFile(), without, 'utf8');
    expect(() => {
      guardTipsWrite(
        shippedFile(),
        `${SHIPPED_HERE.trim()}\n2. a project tip → recorded here\n`,
        SHIPPED_HERE,
        undefined,
        ws(),
      );
    }).not.toThrow();
  });

  it('does not blame an unrelated shipped edit for a pair that was already on file', () => {
    makeForgeWorkspace('forge-llm');
    // Both tables already hold the line (the pre-phase-3 state): rewording the
    // shipped file must go through, because nothing in it grew.
    const shippedWithBoth = `${SHIPPED_HERE.trim()}\n2. a project tip → recorded here\n`;
    expect(() => {
      guardTipsWrite(
        shippedFile(),
        `${shippedWithBoth}3. another tip → reworded\n`,
        shippedWithBoth,
        undefined,
        ws(),
      );
    }).not.toThrow();
  });

  it('guards nothing of the shipped path in a workspace that is not Forge', () => {
    makeForgeWorkspace('my-app');
    expect(isShippedTipsPath(shippedFile(), ws())).toBe(false);
    expect(() => {
      guardTipsWrite(
        shippedFile(),
        `${SHIPPED_HERE.trim()}\n2. a project tip → recorded here\n`,
        SHIPPED_HERE,
        undefined,
        ws(),
      );
    }).not.toThrow();
  });

  it('names the same refusal from the rule alone, for a caller that writes the file itself', () => {
    expect(
      shippedTipsWriteRefusal({
        proposed: `## EDIT\n1. a tip → mistake\n`,
        previous: '',
        projectText: `## EDIT\n1. a tip → mistake\n`,
      }),
    ).toBe(
      'that line is still in docs/CODING_TIPS.md: delete it there first, ' +
        'then add it here: "1. a tip → mistake"',
    );
  });
});
