import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { parseSessionLogRows } from '../../src/sessions/sessionLogRows';

type ObjToken = { kind: 'obj'; data: Record<string, unknown> };
type NoiseToken = { kind: 'noise'; text: string };
type Token = ObjToken | NoiseToken;

// A JSON object line whose keys never collide with the parser's own control
// fields (`type: cursor`, `role`), so the main property exercises the plain
// "object lines, in order" contract without the replay/cursor machinery.
const objectData = fc
  .dictionary(
    fc.string({ minLength: 1, maxLength: 5 }).filter(
      (key) => key !== '__seq__' && key !== 'type' && key !== 'role',
    ),
    fc.jsonValue(),
    { maxKeys: 3 },
  )
  .map((data): ObjToken => ({ kind: 'obj', data }));

const arrayLine = fc
  .array(fc.jsonValue(), { maxLength: 3 })
  .map((value): NoiseToken => ({ kind: 'noise', text: JSON.stringify(value) }));

const scalarLine = fc
  .oneof(
    fc.integer(),
    fc.double({ noNaN: true, noDefaultNaN: true }),
    fc.boolean(),
    fc.string({ maxLength: 8 }),
    fc.constant(null),
  )
  .map((value): NoiseToken => ({ kind: 'noise', text: JSON.stringify(value) }));

// A torn line: a prefix of a serialized object, always missing the closing
// brace so it can never parse as JSON.
const tornLine = fc
  .integer({ min: 1, max: 11 })
  .map((n): NoiseToken => ({ kind: 'noise', text: '{"a":1,"b":2}'.slice(0, n) }));

const blankLine = fc.constantFrom('', '   ', '\t') as unknown as fc.Arbitrary<NoiseToken>;

const noiseToken = fc.oneof(arrayLine, scalarLine, tornLine, blankLine);

const token = fc.oneof(objectData, noiseToken);
const lineEntry = fc.tuple(fc.constantFrom('\n', '\r\n'), token);

describe('property: parseSessionLogRows', () => {
  it('never throws on any mix of object, array, scalar, torn and blank lines', () => {
    fc.assert(
      fc.property(fc.array(lineEntry, { minLength: 0, maxLength: 24 }), (entries) => {
        const raw = entries.map(([eol, token]) => lineText(token) + eol).join('');
        expect(() => parseSessionLogRows(raw)).not.toThrow();
      }),
    );
  });

  it('returns exactly the object lines, parsed, in order', () => {
    fc.assert(
      fc.property(fc.array(lineEntry, { minLength: 0, maxLength: 24 }), (entries) => {
        let seq = 0;
        const lines: string[] = [];
        const expected: Array<Record<string, unknown>> = [];
        for (const [eol, token] of entries) {
          if (token.kind === 'obj') {
            const obj = { __seq__: seq++, ...token.data };
            const line = JSON.stringify(obj);
            lines.push(line + eol);
            expected.push(JSON.parse(line) as Record<string, unknown>);
          } else {
            lines.push(token.text + eol);
          }
        }
        expect(parseSessionLogRows(lines.join(''))).toEqual(expected);
      }),
    );
  });

  it('collapses a repeated contiguous run — the one documented difference from "every object line, in order"', () => {
    // Pre-cursor logs re-appended the whole transcript on each reload, so the
    // parser drops a repeated contiguous run of >= 2 rows. A main-property
    // generator that reused object content would lose the duplicate here; the
    // per-line unique `__seq__` keeps every object distinct so the property
    // above stays honest about ordering.
    const block = [{ a: 1 }, { b: 2 }];
    const raw = [...block, ...block].map((row) => JSON.stringify(row)).join('\n');
    expect(parseSessionLogRows(raw)).toEqual(block);
  });
});

function lineText(token: Token): string {
  if (token.kind === 'obj') return JSON.stringify({ __seq__: -1, ...token.data });
  return token.text;
}
