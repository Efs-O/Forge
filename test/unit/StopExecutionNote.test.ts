import { afterEach, describe, expect, it, vi } from 'vitest';
import { backgroundExecutionManager } from '../../src/tools/BackgroundExecutionManager';
import { makeStopExecutionTool } from '../../src/tools/backgroundExecutionTools';

/**
 * A finished job answers `stop_execution` with its own outcome, and that outcome
 * reads like the stop went wrong: `status: failed, exit_code: 1`. Only an
 * interruption reports `terminated` with a null exit code, so the result has to
 * say which of the two it is — the model acted on the difference before the
 * distinction existed anywhere but in a tips table.
 */
describe('stop_execution on a job that already ended', () => {
  afterEach(async () => {
    await backgroundExecutionManager.dispose();
  });

  it('says the job ended on its own, naming the exit code it produced', async () => {
    const started = backgroundExecutionManager.start({
      command: process.execPath,
      args: ['-e', 'process.exit(3)'],
      cwd: process.cwd(),
    });
    await vi.waitFor(() =>
      expect(backgroundExecutionManager.list().find((item) => item.id === started.id)?.status).toBe(
        'failed',
      ),
    );

    const text = String(
      await makeStopExecutionTool().handler({
        execution_id: started.id,
      }),
    );
    // The whole result is JSON, so the explanation has to be a field in it —
    // text after the closing brace breaks any consumer that parses the result.
    const parsed = JSON.parse(text) as { status: string; note?: string };
    expect(parsed.status).toBe('failed');
    expect(parsed.note).toContain('had already ended on its own');
    expect(parsed.note).toContain('exit_code: 3');
    expect(parsed.note).toContain('status "terminated" with exit_code null');
  });

  it("names the pid it interrupted and the same kill in the agent's own words", async () => {
    const started = backgroundExecutionManager.start({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
    });
    await vi.waitFor(() =>
      expect(backgroundExecutionManager.list().find((item) => item.id === started.id)?.status).toBe(
        'running',
      ),
    );

    const text = String(
      await makeStopExecutionTool().handler({
        execution_id: started.id,
      }),
    );
    const parsed = JSON.parse(text) as { status: string; note?: string };
    expect(parsed.status).toBe('terminated');
    expect(parsed.note ?? '').not.toContain('had already ended on its own');
    // Tonight (2026-11-14) a stopped CI run answered `terminated` while its
    // children ran on and held the CI lock. The note hands the agent the exact
    // kill for the pid, so it can clear what the tree walk may have missed.
    expect(parsed.note).toContain(`interrupted pid ${started.pid}`);
    expect(parsed.note).toContain(`taskkill /PID ${started.pid} /T /F`);
    expect(parsed.note).toContain(`kill -${started.pid}`);
  });
});
