import { describe, expect, it } from 'vitest';
import { normalizeQuestions } from '../../src/util/questionAnswers';
import { isAnswered, togglePick } from '../../src/util/questionPicks';

describe('question pick reducer', () => {
  it('replaces and clears a single-select pick', () => {
    const spec = normalizeQuestions({ prompt: 'Color?', options: ['red', 'blue'] })[0]!;
    expect(togglePick(spec, [], 0)).toEqual([0]);
    expect(togglePick(spec, [0], 1)).toEqual([1]);
    expect(togglePick(spec, [1], 1)).toEqual([]);
  });

  it('toggles multi-select picks in option order', () => {
    const spec = normalizeQuestions({
      questions: [{ prompt: 'Stores?', multiSelect: true, options: ['A', 'B', 'C'] }],
    })[0]!;
    expect(togglePick(spec, [], 2)).toEqual([2]);
    expect(togglePick(spec, [2], 0)).toEqual([0, 2]);
    expect(togglePick(spec, [0, 2], 2)).toEqual([0]);
  });

  it('exclusive options clear other picks and ordinary options clear exclusives', () => {
    const spec = normalizeQuestions({
      questions: [
        {
          prompt: 'Stores?',
          multiSelect: true,
          options: ['Postgres', 'Redis', { label: 'None', exclusive: true }],
        },
      ],
    })[0]!;
    expect(togglePick(spec, [0, 1], 2)).toEqual([2]);
    expect(togglePick(spec, [2], 1)).toEqual([1]);
  });

  it('requires a pick or a nonblank note to count as answered', () => {
    expect(isAnswered([0], undefined)).toBe(true);
    expect(isAnswered([], 'a note')).toBe(true);
    expect(isAnswered([], '  \n')).toBe(false);
    expect(isAnswered([], undefined)).toBe(false);
  });

  it('rejects an option index outside the spec', () => {
    const spec = normalizeQuestions({ prompt: 'Color?', options: ['red', 'blue'] })[0]!;
    expect(() => togglePick(spec, [], 2)).toThrow('out of range');
  });
});
