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

    const text = (await makeStopExecutionTool().handler({
      execution_id: started.id,
    })) as string;

    expect(text).toContain('had already ended on its own');
    expect(text).toContain('exit_code: 3');
    expect(text).toContain('status "terminated" with exit_code null');
  });

  it('adds nothing when the call really did interrupt the job', async () => {
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

    const text = (await makeStopExecutionTool().handler({
      execution_id: started.id,
    })) as string;

    expect(text).not.toContain('had already ended on its own');
    expect(text).toContain('terminated');
  });
});
