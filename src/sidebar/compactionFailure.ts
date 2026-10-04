export type CompactionFailureCategory =
  | 'incomplete-output'
  | 'budget-refusal'
  | 'invalid-summary'
  | 'model-error'
  | 'cancelled'
  | 'unknown';

export class CompactionFailure extends Error {
  constructor(
    readonly category: CompactionFailureCategory,
    message: string,
  ) {
    super(message);
    this.name = 'CompactionFailure';
  }
}

export function compactionFailureCategory(error: unknown): CompactionFailureCategory {
  if (error instanceof CompactionFailure) return error.category;
  if (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'CancellationError')
  ) {
    return 'cancelled';
  }
  return 'unknown';
}
