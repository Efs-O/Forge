import { describe, expect, it } from 'vitest';
import { spawnAndWait } from '../../src/util/processSpawn';
import { MAX_FOREGROUND_OUTPUT_CHARS, RollingOutputCap } from '../../src/util/outputCap';

/**
 * #11 — foreground exec output must be capped WHILE it is read, not after the
 * process exits. The old code accumulated the whole stream in a string, so a
 * child that wrote gigabytes pinned that much in the extension host for the
 * life of the call. `RollingOutputCap` keeps only a head+tail of a fixed
 * budget (200k, matching the background path) and drops the middle as it goes;
 * the pipes keep draining because every chunk is consumed.
 */
describe('RollingOutputCap', () => {
  it('keeps a faithful head and tail and reports the dropped middle', () => {
    const cap = new RollingOutputCap(100); // head 25, tail 75
    cap.append('H');
    cap.append('x'.repeat(200));
    cap.append('T');
    expect(cap.dropped).toBe(102);
    const text = cap.text();
    expect(text.startsWith('H')).toBe(true);
    expect(text.endsWith('T')).toBe(true);
    expect(text).toContain('characters dropped');
  });

  it('leaves a stream under the budget whole, with nothing dropped', () => {
    const cap = new RollingOutputCap(100);
    cap.append('short');
    expect(cap.dropped).toBe(0);
    expect(cap.text()).toBe('short');
  });

  it('never grows past the budget no matter how much is fed', () => {
    const cap = new RollingOutputCap(1000);
    for (let i = 0; i < 50; i++) cap.append('y'.repeat(10_000));
    expect(cap.text().length).toBeLessThanOrEqual(1000 + 64);
    expect(cap.dropped).toBeGreaterThan(0);
  });
});

describe('spawnAndWait foreground output cap', () => {
  it('caps a large stdout while reading, keeping the head and tail', async () => {
    const result = await spawnAndWait(
      process.execPath,
      ['-e', `process.stdout.write('HEAD' + 'x'.repeat(500_000) + 'TAIL')`],
      process.cwd(),
      30_000,
    );
    // Bounded by the cap plus the drop marker — not the full 500k.
    expect(result.stdout.length).toBeLessThanOrEqual(MAX_FOREGROUND_OUTPUT_CHARS + 100);
    // The head and tail survive; the middle is dropped and counted.
    expect(result.stdout.startsWith('HEAD')).toBe(true);
    expect(result.stdout.endsWith('TAIL')).toBe(true);
    expect(result.stdout).toContain('characters dropped');
    expect(result.stdoutDropped).toBeGreaterThan(0);
    expect(result.exitCode).toBe(0);
  });

  it('leaves a small stdout whole and unmarked', async () => {
    const result = await spawnAndWait(
      process.execPath,
      ['-e', `process.stdout.write('hello')`],
      process.cwd(),
      30_000,
    );
    expect(result.stdout).toBe('hello');
    expect(result.stdoutDropped).toBe(0);
    expect(result.stdout).not.toContain('characters dropped');
  });

  it('caps stderr independently of stdout', async () => {
    const result = await spawnAndWait(
      process.execPath,
      ['-e', `process.stderr.write('E'.repeat(300_000))`],
      process.cwd(),
      30_000,
    );
    expect(result.stderr.length).toBeLessThanOrEqual(MAX_FOREGROUND_OUTPUT_CHARS + 100);
    expect(result.stderrDropped).toBeGreaterThan(0);
    expect(result.stdout).toBe('');
  });
});
