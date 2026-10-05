import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexMessage, queueToCodex } from '../../src/agentBus/codexDelivery';
import { buildCliProcessInvocation } from '../../src/agents/cliProcess';

const { spawn, waitForExit, resolveExecutable } = vi.hoisted(() => ({
  spawn: vi.fn(),
  waitForExit: vi.fn(),
  resolveExecutable: vi.fn(),
}));

vi.mock('../../src/agents/cliProcess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/agents/cliProcess')>()),
  spawnCliProcess: spawn,
  waitForCliProcessExit: waitForExit,
  terminateProcessTree: vi.fn(),
}));
vi.mock('../../src/agents/resolveCliExecutable', () => ({
  resolveCliExecutable: resolveExecutable,
}));

const thread = '12345678-1234-1234-1234-123456789abc';
const cli = 'codex';
const executable = 'C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd';
const replyPath = 'C:\\Users\\tester\\.forge\\agent-bus\\outbox\\fg1791234567890-12345678-reply.md';

function encodedCommand(message: string): string {
  return buildCliProcessInvocation(
    {
      executable,
      args: ['queue', '--thread', thread, '--message', message],
      cwd: 'C:\\',
    },
    'win32',
  ).args[3]!;
}

afterEach(() => vi.clearAllMocks());

describe('Codex queue cmd.exe encoded length', () => {
  it('admits 6,000 chars of prose and measures the same encoded argv as the shim builder', async (ctx) => {
    if (process.platform !== 'win32') ctx.skip();
    resolveExecutable.mockResolvedValue(executable);
    spawn.mockReturnValue({ stderr: { on: vi.fn() }, stdout: { resume: vi.fn() } });
    waitForExit.mockResolvedValue({ code: 0 });
    const message = codexMessage(replyPath, 'fg1791234567890-12345678', 's', 'x'.repeat(6000));
    const expected = encodedCommand(message);
    expect(expected.length).toBeLessThanOrEqual(8191);

    await queueToCodex(cli, thread, message);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({
      executable,
      args: ['queue', '--thread', thread, '--message', message],
    });
    expect(spawn.mock.calls[0]?.[1]?.args[3]).toBe(expected);
  });

  it('refuses a 4,000-quote question before spawning and reports the encoded length', async (ctx) => {
    if (process.platform !== 'win32') ctx.skip();
    resolveExecutable.mockResolvedValue(executable);
    spawn.mockReturnValue({ stderr: { on: vi.fn() }, stdout: { resume: vi.fn() } });
    const message = codexMessage(replyPath, 'fg1791234567890-12345678', 's', '"'.repeat(4000));
    const expectedLength = encodedCommand(message).length;
    await expect(queueToCodex(cli, thread, message)).rejects.toThrow(
      new RegExp(`encoded Codex command.*${expectedLength}.*8,191`),
    );
    expect(spawn).not.toHaveBeenCalled();
  });
});
