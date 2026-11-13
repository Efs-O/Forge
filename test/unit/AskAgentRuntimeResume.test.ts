import { describe, expect, it, vi } from 'vitest';
import { makeAskAgentRuntime } from '../../src/agentLinks/askAgentRuntime';
import type { AgentKind, AgentLink } from '../../src/agentLinks/chatAgentLinks';
import type { CliAgentDriver, CliAgentRunOptions } from '../../src/agents/CliAgentDriver';
import type { ForgeConfig } from '../../src/config/types';

// The stderr tail Codex printed twice on the owner's machine (2026-11-06) when
// a thread created by an earlier ask still had a registered active writer.
const WRITER_CONFLICT =
  'codex CLI exited with code 1: ERROR codex_core::session: Failed to create session: ' +
  'thread-store conflict: thread 01a1b28d-10ee-7421-946f-55d392bf385a already has an active writer\n' +
  'Error: thread/resume: thread/resume failed: thread 01a1b28d-10ee-7421-946f-55d392bf385a ' +
  'already has an active writer (code -32600)';

const SESSION = '01a1b28d-10ee-7421-946f-55d392bf385a';

it('does not launch a CLI when Stop arrives during executable resolution', async () => {
  const run = vi.fn(async () => ({ status: 'completed', finalText: 'ok' }));
  const controller = new AbortController();
  const pending = runtimeWith(run).runHeadless({
    agent: 'codex',
    link: link('codex'),
    prompt: 'Review',
    startNew: true,
    model: 'runtime-model',
    effort: 'high',
    sessionTitle: 'Task',
    signal: controller.signal,
    onSessionId: vi.fn(),
  });
  controller.abort();
  await pending;
  expect(run).not.toHaveBeenCalled();
});

it('forwards explicit model and effort to a fresh driver run without resuming a link', async () => {
  const run = vi.fn(async () => ({ status: 'completed', finalText: 'ok' }));
  await runtimeWith(run).runHeadless({
    agent: 'codex',
    link: link('codex'),
    prompt: 'Review',
    startNew: true,
    model: 'runtime-model',
    effort: 'ultra',
    sessionTitle: 'Task',
    signal: new AbortController().signal,
    onSessionId: vi.fn(),
  });
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({ model: 'runtime-model', effort: 'ultra' }),
  );
  expect(run.mock.calls[0]?.[0]).not.toHaveProperty('sessionId');
  expect(run.mock.calls[0]?.[0]).not.toHaveProperty('createSessionId');
});

function runtimeWith(run: (options: CliAgentRunOptions) => Promise<unknown>) {
  return makeAskAgentRuntime({
    // An existing absolute path, so the CLI resolver accepts it as is.
    getConfig: () =>
      ({
        agent_bus: {
          enabled: true,
          claude_cli: process.execPath,
          codex_cli: process.execPath,
          copilot_cli: process.execPath,
        },
      }) as ForgeConfig,
    driver: { run } as unknown as CliAgentDriver,
  });
}

function link(agent: AgentKind): AgentLink {
  return {
    kind: agent,
    sessionId: SESSION,
    cwd: 'C:/repo',
    title: 'Forge · chat',
    linkedAt: 1,
    lastUsedAt: 1,
    origin: 'forge-created',
  };
}

/** Run one headless ask and hand back both its result and what the driver got. */
async function headlessRun(
  agent: AgentKind,
  headless: { createSessionId?: string; startNew?: boolean },
  result: { status: 'completed' | 'failed'; finalText: string; error?: string } = {
    status: 'completed',
    finalText: 'ok',
  },
) {
  const run = vi.fn(async () => result);
  const runtime = runtimeWith(run);
  const outcome = await runtime.runHeadless({
    agent,
    link: link(agent),
    prompt: 'Continue',
    ...(headless.createSessionId ? { createSessionId: headless.createSessionId } : {}),
    ...(headless.startNew ? { startNew: true } : {}),
    sessionTitle: 'Forge · chat',
    signal: new AbortController().signal,
    onSessionId: vi.fn(),
  });
  return { outcome, options: run.mock.calls[0]?.[0] };
}

async function resume(agent: AgentKind, error: string, createSessionId?: string) {
  const { outcome } = await headlessRun(
    agent,
    { createSessionId },
    { status: 'failed', finalText: '', error },
  );
  return outcome;
}

describe('ask_agent headless session selection', () => {
  // A chat's first Codex ask has no thread id yet, so the link it runs on is
  // Forge's placeholder. Handed to `codex exec resume` that string is read as a
  // thread NAME, which would capture every first ask and drop the sandbox flag,
  // so `startNew` must reach the driver as neither id.
  it('hands the driver no session at all when the caller asks for a new one', async () => {
    const { options } = await headlessRun('codex', { startNew: true });
    expect(options?.sessionId).toBeUndefined();
    expect(options?.createSessionId).toBeUndefined();
    expect(options?.task).toBe('Continue');
    expect(options?.sessionTitle).toBe('Forge · chat');
    expect(options?.cwd).toBe('C:/repo');
  });

  it('resumes the linked thread when the caller did not ask for a new one', async () => {
    const { options } = await headlessRun('codex', {});
    expect(options?.sessionId).toBe(SESSION);
    expect(options?.createSessionId).toBeUndefined();
  });

  it('passes a pre-created id as createSessionId, never as a resume', async () => {
    const { options } = await headlessRun('claude', { createSessionId: 'a-session-id' });
    expect(options?.createSessionId).toBe('a-session-id');
    expect(options?.sessionId).toBeUndefined();
  });

  it('does not call a writer conflict on a new-session run a locked resume', async () => {
    const { outcome } = await headlessRun(
      'codex',
      { startNew: true },
      {
        status: 'failed',
        finalText: '',
        error: WRITER_CONFLICT,
      },
    );
    expect(outcome.sessionLocked).toBeUndefined();
    expect(outcome.status).toBe('failed');
  });
});

describe('ask_agent headless resume failure classification', () => {
  it('marks a Codex writer conflict as locked, not gone', async () => {
    const result = await resume('codex', WRITER_CONFLICT);
    expect(result).toMatchObject({ status: 'failed', sessionLocked: true });
    expect(result.sessionGone).toBeUndefined();
  });

  it('still marks a gone Codex thread as gone, not locked', async () => {
    const result = await resume('codex', 'Error: thread 01a1b28d not found');
    expect(result).toMatchObject({ status: 'failed', sessionGone: true });
    expect(result.sessionLocked).toBeUndefined();
  });

  it.each([
    'Error: thread/resume failed: invalid request (code -32600)',
    'codex CLI exited with code 1: auth expired',
    'codex CLI exceeded 600000ms timeout.',
  ])('leaves an unrelated Codex failure unclassified: %s', async (error) => {
    const result = await resume('codex', error);
    expect(result).toEqual({ status: 'failed', finalText: '', error });
  });

  it('classifies the writer conflict for Codex only', async () => {
    for (const agent of ['claude', 'copilot'] as const) {
      const result = await resume(agent, WRITER_CONFLICT);
      expect(result.sessionLocked).toBeUndefined();
    }
  });
});
