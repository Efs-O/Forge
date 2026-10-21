import type { QuestionSpec } from './questionAnswers';

/** Toggle an option while preserving the order of the spec, not click order. */
export function togglePick(spec: QuestionSpec, picks: readonly number[], index: number): number[] {
  assertPicks(spec, picks);
  if (!Number.isInteger(index) || spec.options[index] === undefined) {
    throw new RangeError('Question option index is out of range.');
  }
  if (!spec.multiSelect) return picks.includes(index) ? [] : [index];

  const option = spec.options[index]!;
  if (picks.includes(index)) return picks.filter((picked) => picked !== index);
  const next = option.exclusive
    ? [index]
    : [...picks.filter((picked) => !spec.options[picked]!.exclusive), index];
  return next.sort((a, b) => a - b);
}

/** A nonblank note is an answer even when the user chose no options. */
export function isAnswered(picks: readonly number[], note: string | undefined): boolean {
  return picks.length > 0 || Boolean(note?.trim());
}

function assertPicks(spec: QuestionSpec, picks: readonly number[]): void {
  const seen = new Set<number>();
  for (const pick of picks) {
    if (!Number.isInteger(pick) || spec.options[pick] === undefined || seen.has(pick)) {
      throw new RangeError('Question picks must be unique valid option indexes.');
    }
    seen.add(pick);
  }
}
