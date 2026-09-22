/** Consecutive failures before a job is backed off (B.3). */
export const BACKOFF_THRESHOLD = 3;
/** The maximum backoff interval (B.3). */
export const MAX_BACKOFF_MS = 24 * 60 * 60_000;
