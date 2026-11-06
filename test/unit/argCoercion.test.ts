import { describe, expect, it } from 'vitest';
import { isJsonObject, parseJson } from '../../src/tools/jsonInput';

describe('strict JSON argument parsing', () => {
  it('parses a valid JSON object without changing its values', () => {
    expect(parseJson('{"path":"N:\\\\repo\\\\file.ts"}')).toEqual({
      ok: true,
      value: { path: 'N:\\repo\\file.ts' },
    });
  });

  it('returns malformed escapes as parse errors without repairing them', () => {
    const raw = String.raw`{"path":"N:\myrepo\file.ts"}`;
    const result = parseJson(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(SyntaxError);
  });

  it('recognizes only non-null, non-array JSON objects', () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject([])).toBe(false);
  });

  it('does not turn a quoted array into an array value', () => {
    expect(parseJson('"[1,2]"')).toEqual({ ok: true, value: '[1,2]' });
  });

  it('does not turn a quoted boolean or number into a primitive', () => {
    expect(parseJson('{"flag":"true","count":"5"}')).toEqual({
      ok: true,
      value: { flag: 'true', count: '5' },
    });
  });

  it('reports incomplete JSON instead of attempting a repair', () => {
    const result = parseJson('{"path":"unfinished');
    expect(result.ok).toBe(false);
  });

  it('preserves valid JSON escape sequences as JSON defines them', () => {
    expect(parseJson('{"text":"line\\nnext"}')).toEqual({
      ok: true,
      value: { text: 'line\nnext' },
    });
  });

  it('preserves a malformed unicode escape as a parser refusal', () => {
    const result = parseJson(String.raw`{"text":"\u12"}`);
    expect(result.ok).toBe(false);
  });
});
