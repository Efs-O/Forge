import { describe, expect, it } from 'vitest';
import { makeExecCommandTool } from '../../src/tools/execTools';
import {
  makeListExecutionsTool,
  makeMonitorExecutionTool,
  makeStopExecutionTool,
} from '../../src/tools/backgroundExecutionTools';

describe('exec_command safety policy', () => {
  it('rejects a denylisted command before spawning it', async () => {
    await expect(
      makeExecCommandTool().handler({
        command: 'git',
        args: ['reset', '--hard'],
        cwd: process.cwd(),
      }),
    ).rejects.toThrow('denylist pattern');
  });

  it('validates structured output controls before spawning', async () => {
    await expect(
      makeExecCommandTool().handler({
        command: process.execPath,
        args: ['-e', 'console.log("should not run")'],
        head_lines: 1,
        tail_lines: 1,
      }),
    ).rejects.toThrow('head_lines and tail_lines cannot be used together');
  });

  it('starts a background execution and monitors it to completion', async () => {
    const start = await makeExecCommandTool().handler({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => process.stdout.write("done\\n"), 30)'],
      cwd: process.cwd(),
      background: true,
    });
    const started = JSON.parse(start as string) as { execution_id: string };
    expect(started.execution_id).toMatch(/^exec-/);

    const result = await makeMonitorExecutionTool().handler({
      execution_id: started.execution_id,
      wait_ms: 1_000,
    });
    const observed = JSON.parse(result as string) as {
      status: string;
      stdout: string;
      next_stdout_cursor: number;
    };
    expect(observed.status).toBe('completed');
    expect(observed.stdout).toContain('done');
    expect(observed.next_stdout_cursor).toBeGreaterThan(0);

    const repeated = await makeMonitorExecutionTool().handler({
      execution_id: started.execution_id,
      stdout_cursor: observed.next_stdout_cursor,
      stderr_cursor: 0,
      wait_ms: 0,
    });
    expect(JSON.parse(repeated as string).stdout).toBe('');
  });

  it('reports an unknown execution when stop is requested', async () => {
    await expect(
      makeStopExecutionTool().handler({ execution_id: 'exec-does-not-exist' }),
    ).rejects.toThrow('unknown execution id');
  });

  it('pages through capped output instead of skipping to the end', async () => {
    const start = await makeExecCommandTool().handler({
      command: process.execPath,
      args: ['-e', "process.stdout.write('x'.repeat(50000))"],
      cwd: process.cwd(),
      background: true,
    });
    const started = JSON.parse(start as string) as { execution_id: string };

    // Read the whole stream back one capped chunk at a time. Before the fix the
    // first call reported a cursor at the very end, so everything the cap held
    // back was unreachable and this loop ended after one 1k chunk.
    let cursor = 0;
    let total = 0;
    let calls = 0;
    for (;;) {
      const raw = (await makeMonitorExecutionTool().handler({
        execution_id: started.execution_id,
        wait_ms: calls === 0 ? 5_000 : 0,
        stdout_cursor: cursor,
        max_output_chars: 1_000,
      })) as string;
      const obs = JSON.parse(raw) as { stdout: string; next_stdout_cursor: number };
      calls += 1;
      total += obs.stdout.length;
      if (obs.stdout.length === 0 || calls > 100) break;
      expect(obs.next_stdout_cursor).toBe(cursor + obs.stdout.length);
      cursor = obs.next_stdout_cursor;
    }
    expect(total).toBe(50_000);
    expect(calls).toBe(51);
  });

  it('distinguishes output dropped by the cap from output not yet read', async () => {
    const start = await makeExecCommandTool().handler({
      command: process.execPath,
      args: ['-e', "process.stdout.write('y'.repeat(260000))"],
      cwd: process.cwd(),
      background: true,
    });
    const started = JSON.parse(start as string) as { execution_id: string };

    const raw = (await makeMonitorExecutionTool().handler({
      execution_id: started.execution_id,
      wait_ms: 10_000,
      stdout_cursor: 0,
      max_output_chars: 1_000,
    })) as string;
    const obs = JSON.parse(raw) as {
      status: string;
      stdout_dropped_chars?: number;
      stdout_note?: string;
      stdout_oldest_available_cursor: number;
      stdout_more_available: boolean;
      next_stdout_cursor: number;
    };
    expect(obs.status).toBe('completed');
    // 260k produced, 200k retained: 60k is gone, and the rest is still readable.
    expect(obs.stdout_dropped_chars).toBe(60_000);
    expect(obs.stdout_oldest_available_cursor).toBe(60_000);
    expect(obs.next_stdout_cursor).toBe(61_000);
    expect(obs.stdout_more_available).toBe(true);
    expect(obs.stdout_note).toContain('cannot be recovered');
  });

  it('reports the time actually waited, not the requested budget', async () => {
    const start = await makeExecCommandTool().handler({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 50)'],
      cwd: process.cwd(),
      background: true,
    });
    const started = JSON.parse(start as string) as { execution_id: string };
    const result = await makeMonitorExecutionTool().handler({
      execution_id: started.execution_id,
      wait_ms: 30_000,
    });
    const observed = JSON.parse(result as string) as {
      status: string;
      waited_ms: number;
      ran_for_ms: number;
    };
    expect(observed.status).toBe('completed');
    expect(observed.waited_ms).toBeLessThan(5_000);
    expect(observed.ran_for_ms).toBeGreaterThanOrEqual(40);
  });

  it('kills a background execution once timeout_ms elapses', async () => {
    const start = await makeExecCommandTool().handler({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      background: true,
      timeout_ms: 150,
    });
    const started = JSON.parse(start as string) as { execution_id: string; status: string };
    expect(started.status).toBe('running');

    const result = await makeMonitorExecutionTool().handler({
      execution_id: started.execution_id,
      wait_ms: 5_000,
    });
    const observed = JSON.parse(result as string) as { status: string; error?: string };
    expect(observed.status).toBe('terminated');
    expect(observed.error).toContain('timed out after 150ms');
  });

  it('leaves a background execution running when no timeout_ms is given', async () => {
    const start = await makeExecCommandTool().handler({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 5000)'],
      cwd: process.cwd(),
      background: true,
    });
    const started = JSON.parse(start as string) as { execution_id: string };

    const listed = JSON.parse((await makeListExecutionsTool().handler({})) as string) as {
      executions: { execution_id: string; status: string }[];
    };
    const found = listed.executions.find((e) => e.execution_id === started.execution_id);
    expect(found?.status).toBe('running');

    const stopped = JSON.parse(
      (await makeStopExecutionTool().handler({ execution_id: started.execution_id })) as string,
    ) as { status: string };
    expect(stopped.status).toBe('terminated');
  });

  it('backs the suggested wait off while a running job stays silent', async () => {
    const start = await makeExecCommandTool().handler({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 300000)'],
      cwd: process.cwd(),
      background: true,
    });
    const started = JSON.parse(start as string) as { execution_id: string };

    // An already-aborted signal makes observe() return at once, so the ladder
    // can be walked without the test actually sleeping for 130 seconds. The
    // suggestion is derived from the REQUESTED wait, never the measured one —
    // which is exactly the property under test.
    const peek = { beforeMutate: (): void => {}, abortSignal: AbortSignal.abort() };
    const ladder: number[] = [];
    for (const requested of [10_000, 20_000, 40_000, 60_000]) {
      const raw = (await makeMonitorExecutionTool().handler(
        {
          execution_id: started.execution_id,
          wait_ms: requested,
          stdout_cursor: 0,
          stderr_cursor: 0,
        },
        peek,
      )) as string;
      const observed = JSON.parse(raw) as {
        status: string;
        suggested_next_wait_ms?: number;
        silence_note?: string;
      };
      expect(observed.status).toBe('running');
      ladder.push(observed.suggested_next_wait_ms ?? -1);
      expect(observed.silence_note).toContain('.incomplete');
    }
    expect(ladder).toEqual([20_000, 40_000, 60_000, 60_000]);

    await makeStopExecutionTool().handler({ execution_id: started.execution_id });
  });

  it('resets the suggested wait and drops the note once output arrives', async () => {
    const start = await makeExecCommandTool().handler({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("tick"); setTimeout(() => {}, 300000)'],
      cwd: process.cwd(),
      background: true,
    });
    const started = JSON.parse(start as string) as { execution_id: string };

    // A real short wait so the child's first chunk reaches the buffer; the
    // assertion below then re-reads it from cursor 0.
    await makeMonitorExecutionTool().handler({
      execution_id: started.execution_id,
      wait_ms: 500,
    });

    const raw = (await makeMonitorExecutionTool().handler(
      {
        execution_id: started.execution_id,
        wait_ms: 40_000,
        stdout_cursor: 0,
        stderr_cursor: 0,
      },
      { beforeMutate: (): void => {}, abortSignal: AbortSignal.abort() },
    )) as string;
    const observed = JSON.parse(raw) as {
      stdout: string;
      suggested_next_wait_ms?: number;
      silence_note?: string;
    };
    expect(observed.stdout).toContain('tick');
    expect(observed.suggested_next_wait_ms).toBe(10_000);
    expect(observed.silence_note).toBeUndefined();

    await makeStopExecutionTool().handler({ execution_id: started.execution_id });
  });

  it('omits the suggestion once the job is no longer running', async () => {
    const start = await makeExecCommandTool().handler({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("bye")'],
      cwd: process.cwd(),
      background: true,
    });
    const started = JSON.parse(start as string) as { execution_id: string };

    const raw = (await makeMonitorExecutionTool().handler({
      execution_id: started.execution_id,
      wait_ms: 20_000,
    })) as string;
    const observed = JSON.parse(raw) as {
      status: string;
      suggested_next_wait_ms?: number;
    };
    expect(observed.status).toBe('completed');
    expect(observed.suggested_next_wait_ms).toBeUndefined();
  });
});
