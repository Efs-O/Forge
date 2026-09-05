import { describe, expect, it } from 'vitest';
import {
  applyEol,
  describeEditMiss,
  dominantEol,
  findEditMatch,
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
    const content = 'intro\r\n\r\nTo run the tests:\r\n\r\n```bash\nnpm test\n```\r\n\r\n## Next\r\n';
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
    const updated =
      content.slice(0, match.index) + 'X' + content.slice(match.index + match.length);
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
    expect(describeEditMiss(yaml, '  num_ctx: 100000\n  n_batch: 4096')).toContain(
      'a later line',
    );
  });

  it('says nothing about indentation for a block that matches outright', () => {
    // findEditMatch handles this; describeEditMiss is only ever called on a miss,
    // but a single short token must not be accused of an indent problem.
    expect(describeEditMiss(yaml, '   x')).not.toContain('leading whitespace');
  });
});
