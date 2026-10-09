import type { Row } from './activityRows';

/**
 * Grouped view (plan § Proposal B): folds each maximal run of `step` and
 * `thinkingGroup` rows between two message boundaries into one `activityGroup`
 * row. Phase 3 replaces this body; until then it returns the rows unchanged.
 */
export function groupActivity(rows: Row[]): Row[] {
  return rows;
}
