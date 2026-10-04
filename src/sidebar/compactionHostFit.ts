import { CompactionFailure } from './compactionFailure';

/** Optional host facts. Required facts (user requests, recorded actions) are never shed. */
export interface OptionalHostFacts {
  repoState: string;
  memoryKeys: string[];
  lastReply: string | undefined;
}

export const REPO_STATE_SHED_MARKER = '[repository state omitted to fit the compaction budget]';

/**
 * Sheds optional facts, least valuable first, until the host block fits.
 * `measure` renders the real candidate, so sizes are actual rather than nominal maxima.
 * Returns the names of what was shed (for the log), mutating `optional` in place.
 */
export function shedOptionalHostFacts(
  optional: OptionalHostFacts,
  measure: () => number,
  maxChars: number,
): string[] {
  const shed: string[] = [];
  const steps: Array<[string, () => boolean]> = [
    [
      'repo state',
      () => {
        if (!optional.repoState || optional.repoState === REPO_STATE_SHED_MARKER) return false;
        optional.repoState = REPO_STATE_SHED_MARKER;
        return true;
      },
    ],
    [
      'memory keys',
      () => {
        if (optional.memoryKeys.length === 0) return false;
        optional.memoryKeys = [];
        return true;
      },
    ],
    [
      'last reply',
      () => {
        if (!optional.lastReply) return false;
        optional.lastReply = undefined;
        return true;
      },
    ],
  ];
  for (const [name, apply] of steps) {
    if (measure() <= maxChars) break;
    if (apply()) shed.push(name);
  }
  return shed;
}

/** Names the largest remaining host component so a refusal says what to reduce. */
export function refuseHostFacts(
  hostChars: number,
  maxChars: number,
  components: Record<string, number>,
): never {
  const [largest] = Object.entries(components).sort((a, b) => b[1] - a[1])[0] ?? ['host facts'];
  throw new CompactionFailure(
    'budget-refusal',
    `Required host-preserved compaction facts need an estimated ${hostChars} characters, above the ${maxChars}-character budget (largest component: ${largest}); previous context kept.`,
  );
}
