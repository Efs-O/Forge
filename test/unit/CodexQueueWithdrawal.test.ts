import { describe, expect, it, vi } from 'vitest';
import { queueToCodex } from '../../src/agentBus/codexDelivery';

/**
 * `codex queue` hands its message to the open Codex session and normally
 * returns fast, but it does that by talking to the same app-server daemon that
 * owns the threads, so a busy or wedged daemon can leave the call sitting there
 * for its whole 30-second bound. That is what the 2026-10-26 audit measured
 * (F5): a Stop whose abort arrived before the call started was never seen by
 * the abort listener (registered only after the executable lookup), the message
 * was delivered anyway, and `/agent/stop` stayed open past the caller's bound
 * while the turn waited for it.
 */
const spawned = vi.hoisted(() => vi.fn());

vi.mock('../../src/agents/resolveCliExecutable', () => ({
  resolveCliExecutable: async () => 'codex',
}));

vi.mock('../../src/agents/cliProcess', () => ({
  spawnCliProcess: (options: { args: readonly string[] }) => {
    spawned(options);
    // A `codex queue` that never returns: the process is up, the daemon has
    // the message, and nothing answers.
    return {
      pid: 4242,
      stdout: { resume: () => undefined },
      stderr: { on: () => undefined },
    } as never;
  },
  terminateProcessTree: vi.fn(async () => undefined),
  waitForCliProcessExit: () => new Promise<never>(() => undefined),
}));

const thread = '12345678-1234-1234-1234-123456789abc';

describe('withdrawing a Codex queue call', () => {
  it('does not deliver when the caller had already given up', async () => {
    const controller = new AbortController();
    controller.abort(); // the Stop arrived while the executable was still being found
    const outcome = await Promise.race([
      queueToCodex('codex', thread, 'a question', controller.signal).then(
        () => 'resolved',
        (error: unknown) => `rejected: ${String(error)}`,
      ),
      new Promise((resolve) => setTimeout(() => resolve('STILL WAITING'), 2_000)),
    ]);
    expect(outcome).toContain('withdrawn');
    // Withdrawing is not delivering: the message must not reach the session.
    expect(spawned).not.toHaveBeenCalled();
  });
});
