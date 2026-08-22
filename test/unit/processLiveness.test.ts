import { describe, expect, it } from 'vitest';
import { isProcessAlive } from '../../src/util/processLiveness';

describe('isProcessAlive', () => {
  it('reports the running test process as alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('reports a PID that cannot exist as dead', () => {
    // Above every platform's pid_max; nothing can be running here.
    expect(isProcessAlive(2 ** 31 - 1)).toBe(false);
  });

  it('rejects malformed pids rather than throwing', () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(1.5)).toBe(false);
    expect(isProcessAlive(Number.NaN)).toBe(false);
  });
});
