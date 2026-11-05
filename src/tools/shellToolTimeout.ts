/** Owns the `shell.timeout_ms` hint text and argument check. */
export const TIMEOUT_HINT =
  'Foreground timeout: 1,000–600,000 ms (default 120,000); set background: true for longer commands.';

/** Returns the timeout refusal when the supplied foreground value is invalid. */
export function shellTimeoutError(value: unknown): string | undefined {
  if (
    value !== undefined &&
    (!Number.isInteger(value) || Number(value) < 1000 || Number(value) > 600000)
  ) {
    return `shell: timeout_ms must be a whole number of milliseconds. ${TIMEOUT_HINT}`;
  }
  return undefined;
}
