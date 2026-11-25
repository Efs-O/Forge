import { describe, expect, it } from 'vitest';
import { recoverFoldedParameters } from '../../src/tools/toolArgumentMarkup';

// Assembled from parts so this file's own text never reads as tool-call markup.
const CLOSE = '<' + '/parameter>';
const OPEN = '<' + 'parameter=';
const OPEN_SP = '<' + 'parameter ';

/** The `read_file` subset the session call carried. */
const READ_FILE = {
  path: { type: 'string' },
  start_line: { type: 'integer' },
  end_line: { type: 'integer' },
  numbered: { type: 'boolean' },
};

/**
 * Session 22f64367 (2026-11-25): the model wrote `<parameter numbered>` with a
 * space instead of `=`, and the engine's parser folded the whole block into the
 * `path` value it was still reading. `read_file` then failed with ENOENT on
 * `docs/CODING_TIPS.md\n</parameter>…`. The block names a declared argument that
 * is not in the call, so the split is not a guess.
 */
describe('recoverFoldedParameters', () => {
  it('splits the row-137 arguments back into the call they meant', () => {
    const present: Record<string, unknown> = {
      path: `docs/CODING_TIPS.md\n${CLOSE}\n${OPEN_SP}numbered>\ntrue`,
      start_line: 7,
      end_line: 13,
    };
    recoverFoldedParameters(READ_FILE, present);
    expect(present).toEqual({
      path: 'docs/CODING_TIPS.md',
      numbered: true,
      start_line: 7,
      end_line: 13,
    });
  });

  it('splits the `=` form too, dropping the block’s own closing tag', () => {
    const present: Record<string, unknown> = {
      path: `docs/CODING_TIPS.md\n${CLOSE}\n${OPEN}numbered>\ntrue\n${CLOSE}`,
      start_line: 7,
      end_line: 13,
    };
    recoverFoldedParameters(READ_FILE, present);
    expect(present).toEqual({
      path: 'docs/CODING_TIPS.md',
      numbered: true,
      start_line: 7,
      end_line: 13,
    });
  });

  it('recovers several folded blocks in one value', () => {
    const present: Record<string, unknown> = {
      path: `a.md\n${CLOSE}\n${OPEN}numbered>\ntrue\n${CLOSE}\n${OPEN}start_line>\n7`,
      end_line: 13,
    };
    recoverFoldedParameters(READ_FILE, present);
    expect(present).toEqual({ path: 'a.md', numbered: true, start_line: 7, end_line: 13 });
  });

  it('reads the recovered text as the type the schema declares', () => {
    const present: Record<string, unknown> = {
      name: `list\n${CLOSE}\n${OPEN_SP}count>\n-12\n${CLOSE}\n${OPEN}flag>\nfalse`,
    };
    recoverFoldedParameters(
      { name: { type: 'string' }, count: { type: 'integer' }, flag: { type: 'boolean' } },
      present,
    );
    expect(present).toEqual({ name: 'list', count: -12, flag: false });
  });

  it('parses a recovered array or object through the JSON text reader', () => {
    const present: Record<string, unknown> = {
      path: `a.md\n${CLOSE}\n${OPEN}edits>\n[{"old_str": "a", "new_str": "b"}]`,
    };
    recoverFoldedParameters({ path: { type: 'string' }, edits: { type: 'array' } }, present);
    expect(present).toEqual({ path: 'a.md', edits: [{ old_str: 'a', new_str: 'b' }] });
  });

  it('changes nothing when the folded tag names an argument the tool does not declare', () => {
    const folded = `a.md\n${CLOSE}\n${OPEN_SP}nosuch>\nx`;
    const present: Record<string, unknown> = { path: folded };
    recoverFoldedParameters(READ_FILE, present);
    expect(present).toEqual({ path: folded });
  });

  it('changes nothing when the folded tag names an argument already in the call', () => {
    const folded = `a.md\n${CLOSE}\n${OPEN}numbered>\ntrue`;
    const present: Record<string, unknown> = { path: folded, numbered: false };
    recoverFoldedParameters(READ_FILE, present);
    expect(present).toEqual({ path: folded, numbered: false });
  });

  it('changes nothing when the folded tag names the value it sits in', () => {
    const folded = `a.md\n${CLOSE}\n${OPEN}path>\nb.md`;
    const present: Record<string, unknown> = { path: folded };
    recoverFoldedParameters(READ_FILE, present);
    expect(present).toEqual({ path: folded });
  });

  it('changes nothing when the recovered text does not fit the declared type', () => {
    const folded = `a.md\n${CLOSE}\n${OPEN}numbered>\nmaybe`;
    const present: Record<string, unknown> = { path: folded };
    recoverFoldedParameters(READ_FILE, present);
    expect(present).toEqual({ path: folded });
  });

  it('changes nothing when a later block is unreadable, so no part of the call moves', () => {
    const folded = `a.md\n${CLOSE}\n${OPEN}numbered>\ntrue\n${CLOSE}\n${OPEN}start_line>\nseven`;
    const present: Record<string, unknown> = { path: folded };
    recoverFoldedParameters(READ_FILE, present);
    expect(present).toEqual({ path: folded });
  });

  it('leaves a value with no folded block alone', () => {
    const present: Record<string, unknown> = { path: 'a.md', numbered: true };
    recoverFoldedParameters(READ_FILE, present);
    expect(present).toEqual({ path: 'a.md', numbered: true });
  });
});
