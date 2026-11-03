import { describe, expect, it } from 'vitest';
import { ReasoningRunaway, ReasoningRunawayGuard } from '../../src/agent/reasoningRunawayGuard';

const repetition = {
  window_chars: 240,
  min_unit_chars: 24,
  min_coverage: 0.6,
};

function runChunks(text: string, chunks: number[]): ReasoningRunaway | null {
  const guard = new ReasoningRunawayGuard({ repetition });
  let offset = 0;
  let result: ReasoningRunaway | null = null;
  for (const size of chunks) {
    result = guard.push(text.slice(offset, offset + size));
    offset += size;
    if (result) break;
  }
  if (offset < text.length && !result) result = guard.push(text.slice(offset));
  return result;
}

function seededChunks(length: number): number[] {
  let seed = 0x5eed1234;
  const chunks: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const size = Math.min(1 + (seed % 31), remaining);
    chunks.push(size);
    remaining -= size;
  }
  return chunks;
}

describe('ReasoningRunawayGuard', () => {
  it('trips exactly when repeated sentence coverage first reaches the threshold', () => {
    const sentence = 'The model repeats a sufficiently long sentence.';
    const normalizedLength = sentence.length;
    const expectedCopies = Math.ceil(
      (repetition.window_chars * repetition.min_coverage) / normalizedLength,
    );
    const guard = new ReasoningRunawayGuard({ repetition });
    let trip: ReasoningRunaway | null = null;
    for (let copy = 0; copy < expectedCopies; copy += 1) {
      trip = guard.push(`${sentence} `);
      if (copy < expectedCopies - 1) expect(trip).toBeNull();
    }
    expect(expectedCopies).toBe(4);
    expect(trip).toEqual({
      kind: 'repetition',
      atChars: expectedCopies * (sentence.length + 1),
      loopStartChars: 0,
      repeatedUnit: sentence.toLowerCase(),
    });
    expect(guard.tripped).toBe(true);
  });

  it('returns the same trip for whole text, characters, and seeded random chunks', () => {
    const sentence = 'The model repeats a sufficiently long sentence.';
    const text = `${sentence} `.repeat(4) + 'x'.repeat(1000);
    const expected = runChunks(text, [text.length]);
    expect(
      runChunks(
        text,
        Array.from({ length: text.length }, () => 1),
      ),
    ).toEqual(expected);
    expect(runChunks(text, seededChunks(text.length))).toEqual(expected);
  });

  it('does not call one long unit repetition even when it fills the window', () => {
    const guard = new ReasoningRunawayGuard({
      repetition: { window_chars: 6000, min_unit_chars: 24, min_coverage: 0.85 },
    });
    expect(guard.push('x'.repeat(5500) + '\n')).toBeNull();
    expect(guard.tripped).toBe(false);
  });

  it('discards over-window unfinished units and keeps later loop offsets exact', () => {
    const windowChars = 6000;
    const coverage = 0.85;
    const unit = 'This complete sentence repeats after an oversized unfinished unit.';
    const expectedCopies = Math.ceil((windowChars * coverage) / unit.length);
    const prefix = 'x'.repeat(200000) + '\n';
    const guard = new ReasoningRunawayGuard({
      repetition: { window_chars: windowChars, min_unit_chars: 24, min_coverage: coverage },
    });
    expect(guard.push(prefix)).toBeNull();

    let trip: ReasoningRunaway | null = null;
    for (let copy = 0; copy < expectedCopies; copy += 1) {
      trip = guard.push(`${unit}\n`);
      if (copy < expectedCopies - 1) expect(trip).toBeNull();
    }
    expect(trip).toEqual({
      kind: 'repetition',
      atChars: prefix.length + expectedCopies * (unit.length + 1),
      loopStartChars: prefix.length,
      repeatedUnit: unit.toLowerCase(),
    });
  });

  it('reports the first loop copy after varied text and leading whitespace for every chunking', () => {
    const variedText = Array.from(
      { length: 30 },
      (_, index) => `Distinct prefix passage ${index} contains its own varied wording.`,
    ).join(' ');
    const leadingWhitespace = '\n   ';
    const sentence = 'The model repeats a sufficiently long sentence.';
    const prefix = `${variedText}${leadingWhitespace}`;
    const text = prefix + `${sentence} `.repeat(4);
    const expectedStart = prefix.length;
    const expected = runChunks(text, [text.length]);

    expect(expected).toMatchObject({ kind: 'repetition', loopStartChars: expectedStart });
    expect(
      runChunks(
        text,
        Array.from({ length: text.length }, () => 1),
      ),
    ).toEqual(expected);
    expect(runChunks(text, seededChunks(text.length))).toEqual(expected);
  });

  it('does not trip on 200,000 characters of distinct sentences', () => {
    const guard = new ReasoningRunawayGuard({
      repetition: { window_chars: 6000, min_unit_chars: 24, min_coverage: 0.85 },
    });
    let result: ReasoningRunaway | null = null;
    for (let index = 0; index < 10000; index += 1) {
      result = guard.push(
        `Distinct numbered sentence ${index.toString().padStart(5, '0')} carries varied context. `,
      );
      expect(result).toBeNull();
    }
    expect(guard.chars).toBeGreaterThanOrEqual(200000);
    expect(guard.tripped).toBe(false);
  });

  it('does not trip for a sentence spread across 20,000 characters of other text', () => {
    const guard = new ReasoningRunawayGuard({
      repetition: { window_chars: 6000, min_unit_chars: 24, min_coverage: 0.85 },
    });
    const repeated = 'A carefully worded sentence that is exactly seventy characters long!!!';
    expect(repeated.length).toBe(70);
    for (let index = 0; index < 21; index += 1) {
      expect(guard.push(`${repeated} `)).toBeNull();
      const filler = `Different background passage number ${index} has extra unique words. `;
      for (let chars = 0; chars < 1000; chars += filler.length)
        expect(guard.push(filler)).toBeNull();
    }
    expect(guard.chars).toBeGreaterThan(20000);
    expect(guard.tripped).toBe(false);
  });

  it('ignores short completed units', () => {
    const guard = new ReasoningRunawayGuard({
      repetition: { window_chars: 100, min_unit_chars: 24, min_coverage: 0.5 },
    });
    for (let index = 0; index < 10000; index += 1) expect(guard.push('ok.\n')).toBeNull();
    expect(guard.tripped).toBe(false);
  });

  it('trips the character cap only after the configured limit', () => {
    const guard = new ReasoningRunawayGuard({ max_reasoning_chars: 5 });
    expect(guard.push('12345')).toBeNull();
    expect(guard.push('x')).toEqual({ kind: 'cap', atChars: 6 });
    expect(guard.tripped).toBe(true);
  });

  it('returns null after tripping and keeps the trip state', () => {
    const guard = new ReasoningRunawayGuard({ max_reasoning_chars: 1 });
    expect(guard.push('ab')).toEqual({ kind: 'cap', atChars: 2 });
    expect(guard.push('more')).toBeNull();
    expect(guard.chars).toBe(6);
    expect(guard.tripped).toBe(true);
  });

  it('never trips with an empty config', () => {
    const guard = new ReasoningRunawayGuard({});
    expect(guard.push('Anything!\n'.repeat(100))).toBeNull();
    expect(guard.tripped).toBe(false);
  });

  it('rejects every invalid numeric setting and names its field', () => {
    const invalid: Array<[string, () => ReasoningRunawayGuard]> = [
      [
        'window_chars',
        () => new ReasoningRunawayGuard({ repetition: { ...repetition, window_chars: 0 } }),
      ],
      [
        'window_chars',
        () => new ReasoningRunawayGuard({ repetition: { ...repetition, window_chars: 1.5 } }),
      ],
      [
        'min_unit_chars',
        () => new ReasoningRunawayGuard({ repetition: { ...repetition, min_unit_chars: -1 } }),
      ],
      [
        'min_unit_chars',
        () => new ReasoningRunawayGuard({ repetition: { ...repetition, min_unit_chars: 1.1 } }),
      ],
      [
        'min_coverage',
        () => new ReasoningRunawayGuard({ repetition: { ...repetition, min_coverage: 0 } }),
      ],
      [
        'min_coverage',
        () => new ReasoningRunawayGuard({ repetition: { ...repetition, min_coverage: 1.1 } }),
      ],
      ['max_reasoning_chars', () => new ReasoningRunawayGuard({ max_reasoning_chars: 0 })],
      ['max_reasoning_chars', () => new ReasoningRunawayGuard({ max_reasoning_chars: 2.5 })],
    ];
    for (const [field, construct] of invalid) {
      expect(construct).toThrow(field);
    }
  });
});
