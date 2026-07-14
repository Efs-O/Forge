export const MAX_WORKERS = 2;
export const MAX_WORKER_TASK_CHARS = 4_000;
export const MAX_REVIEW_TASK_CHARS = 2_000;
export const MAX_CONTEXT_HINTS = 16;
export const MAX_WRITABLE_PATHS = 8;
export const DEFAULT_WORKER_OUTPUT_TOKENS = 1_024;
export const MAX_WORKER_OUTPUT_TOKENS = 4_096;
export const MAX_WORKER_TOOL_ROUNDS = 8;
export const MAX_WORKER_TOOL_CALLS = 16;
export const MAX_WORKER_READ_FILE_BYTES = 256 * 1024;
export const MAX_WORKER_READ_BYTES = 2 * 1024 * 1024;
export const MAX_WORKER_TOOL_RESULT_CHARS = 24_000;
export const MAX_WORKER_TOOL_RESULT_TOTAL_CHARS = 96_000;
export const MAX_DIRECTORY_ENTRIES = 500;
export const MAX_WORKER_FIND_RESULTS = 100;
export const MAX_WORKER_SEARCH_RESULTS = 20;
export const MAX_WORKER_GLOB_CHARS = 256;
export const MAX_WORKER_QUERY_CHARS = 512;
export const MAX_WORKER_FINAL_CHARS = 24_000;
export const WORKER_RUN_TIMEOUT_MS = 600_000;

export function clampWorkerOutputTokens(requested?: number): number {
  if (requested === undefined) return DEFAULT_WORKER_OUTPUT_TOKENS;
  return Math.max(1, Math.min(Math.floor(requested), MAX_WORKER_OUTPUT_TOKENS));
}
