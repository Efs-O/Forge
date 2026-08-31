import { describe, expect, it } from 'vitest';
import { MAX_WAIT_SECONDS, makeWaitTool } from '../../src/tools/waitTool';

const tool = makeWaitTool();
const ctx = (signal?: AbortSignal) => ({
  beforeMutate: () => {},
  ...(signal ? { abortSignal: signal } : {}),
});

describe('wait tool', () => {
  it('waits about as long as asked and reports the measured time', async () => {
    const startedAt = Date.now();
    const result = await tool.handler({ seconds: 1 }, ctx());
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(result).toBe('Waited 1s.');
  });

  // /stop must not leave a turn parked on a timer.
  it('returns as soon as the turn is aborted', async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = tool.handler({ seconds: MAX_WAIT_SECONDS }, ctx(controller.signal));
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(result).toContain('Wait cancelled after');
    expect(result).toContain(`of the ${MAX_WAIT_SECONDS}s requested`);
  });

  it('returns immediately when the turn is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const startedAt = Date.now();
    const result = await tool.handler({ seconds: MAX_WAIT_SECONDS }, ctx(controller.signal));
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(result).toContain('Wait cancelled');
  });

  it('rejects a duration outside the allowed range', async () => {
    await expect(tool.handler({ seconds: 0 }, ctx())).rejects.toThrow(
      new RegExp(`1 to ${MAX_WAIT_SECONDS}`, 'u'),
    );
    await expect(tool.handler({ seconds: MAX_WAIT_SECONDS + 1 }, ctx())).rejects.toThrow(
      new RegExp(`1 to ${MAX_WAIT_SECONDS}`, 'u'),
    );
    await expect(tool.handler({ seconds: 1.5 }, ctx())).rejects.toThrow(/whole number/u);
  });

  it('takes no free-form blob arg', () => {
    const schema = tool.definition.function.parameters;
    expect(schema).toMatchObject({ required: ['seconds'], additionalProperties: false });
    expect(Object.keys((schema as { properties: object }).properties)).toEqual(['seconds']);
  });

  it('points at monitor_execution for waiting on a command', () => {
    expect(tool.definition.function.description).toContain('monitor_execution');
  });
});
