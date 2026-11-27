/** Owns the `shell.timeout_ms` hint text and argument check. */
export const TIMEOUT_HINT =
  'Foreground timeout: 1,000–600,000 ms (default 120,000); set background: true for longer commands.';

/** A longer foreground wait is not refused: the call runs in the background. */
export const FOREGROUND_TIMEOUT_MAX_MS = 600_000;

export interface ShellTimeoutRefusal {
  error: string;
}

export interface ShellTimeoutRun {
  /** Whether the command runs detached, with an `execution_id` instead of output. */
  background: boolean;
  /** Set when a foreground value over the limit moved the call to the background. */
  note?: string;
}

/**
 * Decide how to run one call from its `timeout_ms`.
 *
 * Refusing an over-limit value only taught the model to resend a number inside
 * the range (measured 2026-11-27: 8 refusals in 12,562 shell calls, six of them
 * `900000` for CI or a large test file, two of those already `background: true`
 * and refused anyway). A background run can last as long as it needs, so an
 * over-limit foreground value now runs in the background with the same kill
 * timer, and the result says so. `undefined` keeps today's foreground default.
 */
export function shellTimeoutPlan(
  value: unknown,
  background: boolean,
): ShellTimeoutRefusal | ShellTimeoutRun {
  if (value === undefined) return { background };
  if (!Number.isInteger(value) || Number(value) < 1000) {
    return {
      error: `shell: timeout_ms must be a whole number of milliseconds. ${TIMEOUT_HINT}`,
    };
  }
  if (background) return { background: true };
  if (Number(value) <= FOREGROUND_TIMEOUT_MAX_MS) return { background: false };
  return {
    background: true,
    note:
      `Note: timeout_ms ${value} is over the 600,000 ms foreground limit, so this command ` +
      `runs in the background (execution_id above) and stops after ${value} ms.`,
  };
}
