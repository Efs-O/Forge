import { describe, expect, it } from 'vitest';
import {
  applyEol,
  describeEditMiss,
  dominantEol,
  findEditMatch,
  findIndentShiftedMatch,
} from '../../src/tools/editMatch';

describe('findEditMatch', () => {
  it('finds an exact match and reports its own length', () => {
    const content = 'alpha\nbeta\ngamma\n';
    expect(findEditMatch(content, 'beta')).toEqual({ index: 6, length: 4 });
  });

  it('matches LF old_str against CRLF content', () => {
    const content = 'alpha\r\nbeta\r\ngamma\r\n';
    const match = findEditMatch(content, 'beta\ngamma');
    expect(match).toBeDefined();
    // Spans the CRLF, so the splice replaces the real bytes, not one short.
    expect(content.slice(match!.index, match!.index + match!.length)).toBe('beta\r\ngamma');
  });

  it('matches CRLF old_str against LF content', () => {
    const content = 'alpha\nbeta\ngamma\n';
    const match = findEditMatch(content, 'beta\r\ngamma');
    expect(content.slice(match!.index, match!.index + match!.length)).toBe('beta\ngamma');
  });

  it('matches across a file with mixed endings — the README case', () => {
    const content =
      'intro\r\n\r\nTo run the tests:\r\n\r\n```bash\nnpm test\n```\r\n\r\n## Next\r\n';
    const match = findEditMatch(content, 'To run the tests:\n\n```bash\nnpm test\n```');
    expect(match).toBeDefined();
    expect(content.slice(match!.index, match!.index + match!.length)).toContain('npm test');
  });

  it('returns undefined when the text genuinely differs', () => {
    expect(findEditMatch('alpha\nbeta\n', 'delta')).toBeUndefined();
  });

  // Pre-existing semantics, unchanged here: an empty old_str is an exact match
  // at offset 0, so it inserts rather than failing.
  it('treats an empty old_str as the existing zero-length match', () => {
    expect(findEditMatch('alpha\r\nbeta\r\n', '')).toEqual({ index: 0, length: 0 });
  });

  it('splices correctly using the returned original offsets', () => {
    const content = 'a\r\nb\r\nc\r\n';
    const match = findEditMatch(content, 'b\nc')!;
    const updated = content.slice(0, match.index) + 'X' + content.slice(match.index + match.length);
    expect(updated).toBe('a\r\nX\r\n');
  });
});

describe('dominantEol', () => {
  it('reports CRLF when the file mostly uses it', () => {
    expect(dominantEol('a\r\nb\r\nc\nd\r\n')).toBe('\r\n');
  });

  it('reports LF when the file mostly uses it', () => {
    expect(dominantEol('a\nb\nc\r\nd\n')).toBe('\n');
  });

  it('defaults to LF for a file with no newline at all', () => {
    expect(dominantEol('single line')).toBe('\n');
  });
});

describe('applyEol', () => {
  it('converts LF text to CRLF', () => {
    expect(applyEol('a\nb', '\r\n')).toBe('a\r\nb');
  });

  it('converts CRLF text to LF', () => {
    expect(applyEol('a\r\nb', '\n')).toBe('a\nb');
  });

  it('does not double up on text already in the target ending', () => {
    expect(applyEol('a\r\nb', '\r\n')).toBe('a\r\nb');
  });
});

describe('describeEditMiss', () => {
  it('points at the line number when only a later line differs', () => {
    const content = 'one\ntwo\nthree\n';
    expect(describeEditMiss(content, 'two\nTHREE')).toContain('line 2');
  });

  it('offers the nearest partial line when nothing matches exactly', () => {
    const content = 'const value = 1;\n';
    expect(describeEditMiss(content, 'const value')).toContain('const value = 1;');
  });

  it('names the closest line and where a mid-line slip departs from it', () => {
    const content = 'koi.push({ cx:POND.cx, ph:rf(0,6.28), y:2 });\n';
    const hint = describeEditMiss(content, 'koi.push({ cx:POND.cx, ph:rf(0,6.283), y:2 });');
    expect(hint).toContain('closest line is 1');
    expect(hint).toContain('character 36');
    expect(hint).toContain('Current text (lines 1-1):\n1|koi.push');
  });

  it('includes the closest line plus three numbered lines on each side', () => {
    const content = Array.from(
      { length: 10 },
      (_, index) => `const value${index} = ${index};`,
    ).join('\n');
    const hint = describeEditMiss(content, 'const value5 = 500;');
    expect(hint).toContain('Current text (lines 3-9):');
    expect(hint).toContain('3|const value2 = 2;');
    expect(hint).toContain('9|const value8 = 8;');
    expect(hint).not.toContain('2|const value1');
  });

  it('caps the numbered context at 1200 characters', () => {
    const content = Array.from({ length: 7 }, () => 'x'.repeat(500)).join('\n');
    const hint = describeEditMiss(content, `${'x'.repeat(500)}!`);
    const context = hint.slice(hint.indexOf('Current text'));
    expect(context.length).toBeLessThanOrEqual(1200);
  });

  it('does not call a shared boilerplate prefix the closest line', () => {
    expect(describeEditMiss('const alpha = 1;\n', 'const omega = 2;')).not.toContain('closest');
  });

  it('falls back to a re-read instruction with no usable anchor', () => {
    expect(describeEditMiss('abc\n', 'zz')).toContain('read_file');
  });
});

describe('describeEditMiss — the uniform indent shift', () => {
  // The 2026-09-05 config.yaml session: six consecutive edit_file calls failed
  // because `read_file numbered: true` separated the number from the line with
  // "| ", and the model could not tell that space from the line's own first
  // column. Every old_str it built carried one extra leading space. The generic
  // diagnosis called it "a later line differs" — true by trim(), and it sent
  // the model hunting a later line that was fine.
  const yaml = ['spawn:', '  num_ctx: 100000', '  n_batch: 2048', ''].join('\n');

  it('names leading whitespace rather than blaming a later line', () => {
    const shifted = '   num_ctx: 100000\n   n_batch: 2048';
    const message = describeEditMiss(yaml, shifted);
    expect(message).toContain('leading whitespace');
    expect(message).toContain('2 spaces');
    expect(message).toContain('3 spaces');
    expect(message).not.toContain('a later line');
  });

  it('gives the line the block really starts on', () => {
    expect(describeEditMiss(yaml, '   num_ctx: 100000\n   n_batch: 2048')).toContain('line 2');
  });

  it('still blames a later line when the content genuinely differs', () => {
    expect(describeEditMiss(yaml, '  num_ctx: 100000\n  n_batch: 4096')).toContain('a later line');
  });

  it('says nothing about indentation for a block that matches outright', () => {
    // findEditMatch handles this; describeEditMiss is only ever called on a miss,
    // but a single short token must not be accused of an indent problem.
    expect(describeEditMiss(yaml, '   x')).not.toContain('leading whitespace');
  });
});

describe('findIndentShiftedMatch', () => {
  const splice = (content: string, m: { index: number; length: number; newStr: string }) =>
    content.slice(0, m.index) + m.newStr + content.slice(m.index + m.length);

  it('applies a uniform shift and shifts new_str by the same count', () => {
    const content = 'function f() {\n  r.duckT = 0;\n  r.vy = 1;\n}\n';
    const m = findIndentShiftedMatch(
      content,
      '    r.duckT = 0;\n    r.vy = 1;',
      '    r.duckT = 2;\n    if (a) {\n      r.vy = 3;\n    }',
    );
    expect(m).toMatchObject({ line: 2, shift: -2 });
    expect(splice(content, m!)).toBe(
      'function f() {\n  r.duckT = 2;\n  if (a) {\n    r.vy = 3;\n  }\n}\n',
    );
  });

  it('adds indentation when old_str has less', () => {
    const content = 'if x:\n    y = 1\n    z = 2\n';
    const m = findIndentShiftedMatch(content, 'y = 1\nz = 2', 'y = 10\nz = 20');
    expect(m?.shift).toBe(4);
    expect(splice(content, m!)).toBe('if x:\n    y = 10\n    z = 20\n');
  });

  it('refuses a Python block whose lines shift by different amounts', () => {
    const content = 'if x:\n    y = 1\nz = 2\n';
    // Applying this would move `z = 2` into the if block.
    expect(findIndentShiftedMatch(content, '  y = 1\n  z = 2', '  y = 1\n  z = 3')).toBeUndefined();
  });

  it('refuses when two blocks match once indentation is ignored', () => {
    const content = 'a:\n  value = 1\nb:\n    value = 1\n';
    expect(findIndentShiftedMatch(content, '      value = 1', '      value = 2')).toBeUndefined();
  });

  it('refuses tabs in the file against spaces in old_str', () => {
    const content = 'f() {\n\treturn value;\n}\n';
    expect(
      findIndentShiftedMatch(content, '    return value;', '    return other;'),
    ).toBeUndefined();
  });

  it('refuses a removing shift new_str cannot take', () => {
    const content = 'x {\n  keep = 1;\n}\n';
    expect(
      findIndentShiftedMatch(content, '    keep = 1;', '    keep = 2;\n outer = 3;'),
    ).toBeUndefined();
  });

  it("keeps the file's CRLF ending around the shifted splice", () => {
    const content = 'a {\r\n  b = 1;\r\n  c = 2;\r\n}\r\n';
    const m = findIndentShiftedMatch(
      content,
      '    b = 1;\n    c = 2;\n',
      '    b = 9;\n    c = 8;\n',
    );
    expect(content.slice(m!.index, m!.index + m!.length)).toBe('  b = 1;\r\n  c = 2;\r\n');
    expect(m!.newStr).toBe('  b = 9;\n  c = 8;\n');
  });
});
