import type { UnusableSummaryReason } from './compactionPrompt';

export type CompactionFailureCategory =
  | 'incomplete-output'
  | 'budget-refusal'
  | 'invalid-summary'
  | 'model-error'
  | 'cancelled'
  | 'unknown';

/**
 * Which check rejected a summary as invalid. Fixed labels, Forge's own section
 * names and a length — never model text, because it goes to the session log.
 * Keys are the `compaction_attempt` row's, so the row spreads it unchanged.
 */
export interface InvalidSummaryDetail {
  invalid_reason: 'unusable' | 'missing-sections';
  invalid_check?: UnusableSummaryReason;
  missing_sections?: string[];
  written_chars: number;
}

export class CompactionFailure extends Error {
  constructor(
    readonly category: CompactionFailureCategory,
    message: string,
    readonly invalidSummary?: InvalidSummaryDetail,
  ) {
    super(message);
    this.name = 'CompactionFailure';
  }
}

interface PromptIncompleteLike {
  name: 'PromptIncompleteError';
  finishReason: unknown;
}

function isPromptIncompleteError(error: unknown): error is PromptIncompleteLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'PromptIncompleteError' &&
    'finishReason' in error
  );
}

export function compactionFailureCategory(error: unknown): CompactionFailureCategory {
  if (error instanceof CompactionFailure) return error.category;
  if (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'CancellationError')
  ) {
    return 'cancelled';
  }
  if (isPromptIncompleteError(error)) {
    if (error.finishReason === 'cancelled') return 'cancelled';
    if (error.finishReason === 'length') return 'incomplete-output';
  }
  return 'model-error';
}
