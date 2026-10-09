import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vscode')>();
  return { ...actual, CodeActionKind: { QuickFix: 'quickfix' } };
});
import { backgroundExecutionManager } from '../../src/tools/BackgroundExecutionManager';
import { deactivate } from '../../src/extension';

describe('extension deactivation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('awaits termination of background executions before returning', async () => {
    const pending = Promise.withResolvers<void>();
    const dispose = vi.spyOn(backgroundExecutionManager, 'dispose').mockReturnValue(pending.promise);
    let finished = false;
    const shutdown = deactivate().then(() => { finished = true; });
    await Promise.resolve();
    expect(dispose).toHaveBeenCalledOnce();
    expect(finished).toBe(false);
    pending.resolve();
    await shutdown;
    expect(finished).toBe(true);
  });
});
