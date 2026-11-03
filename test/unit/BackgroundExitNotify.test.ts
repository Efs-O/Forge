import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'fs';
const { registryDir } = vi.hoisted(() => ({
  registryDir: `${process.cwd()}/.test-tmp/background-notify`,
}));
vi.mock('../../src/tools/backgroundRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/tools/backgroundRegistry')>();
  return {
    ...actual,
    backgroundRegistry: new actual.BackgroundRegistry(registryDir, {
      isAlive: () => true,
      processStartMsAsync: async () => 1234,
      killTree: async () => {},
      owner: { pid: process.pid, startedAt: 1234 },
      error: () => {},
      warn: () => {},
      info: () => {},
    }),
  };
});
import { BackgroundExecutionManager, backgroundExecutionManager } from '../../src/tools/BackgroundExecutionManager';
import { makeShellTool } from '../../src/tools/shellTool';
import {
  makeListExecutionsTool,
  makeMonitorExecutionTool,
  makeStopExecutionTool,
  NOTIFY_ON_EXIT_DESCRIPTION,
} from '../../src/tools/backgroundExecutionTools';
import { runningBackgroundExecutionsNotice, deliverBackgroundExitNotice, routeSidebarPrompt } from '../../src/sidebar/backgroundExitNotice';
import { unattendedConversations } from '../../src/sidebar/unattendedConversations';
// SendPipeline logs every turn through SessionLogger; mock it so this file's
// cancelled-turn test does not write session files.
vi.mock('../../src/sidebar/SessionLogger', () => ({
  SessionLogger: vi.fn().mockImplementation(function SessionLoggerMock() {
    return {
      flush: vi.fn(),
      updateTitle: vi.fn(),
      logTurnError: vi.fn(),
      logTurnStopped: vi.fn(),
      logTurnEnd: vi.fn(),
    };
  }),
}));
import { SendPipeline, type SendPipelineDeps } from '../../src/sidebar/SendPipeline';
import { RequestChainLifecycle } from '../../src/sidebar/RequestChainLifecycle';
import { MidTurnInbox } from '../../src/agent/MidTurnInbox';
import type { ConversationRuntime, SidebarRuntime } from '../../src/sidebar/sessionTypes';
import type { ForgeConfig } from '../../src/config/types';
import type { ForgeTurnOutcome } from '../../src/sidebar/turnOutcome';

describe('background shell exit notification', () => {
  const manager = new BackgroundExecutionManager();
  afterEach(async () => {
    await manager.dispose();
    await backgroundExecutionManager.dispose();
    fs.rmSync(registryDir, { recursive: true, force: true });
  });

  it('notifies once on natural exit with bounded tails', async () => {
    const listener = vi.fn();
    manager.onNotifiedExit(listener);
    const execution = manager.start({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("x".repeat(3000))'],
      cwd: process.cwd(),
      notifyConversationId: 'chat',
    });
    await vi.waitFor(() => {
      expect(manager.list().find((item) => item.id === execution.id)?.status).toBe('completed');
    });
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ conversationId: 'chat', status: 'completed' });
    expect(listener.mock.calls[0]?.[0].stdoutTail).toHaveLength(2_000);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('validates notify_on_exit and passes the conversation id to the manager', async () => {
    const startSpy = vi.spyOn(backgroundExecutionManager, 'start').mockReturnValue({
      id: 'exec-shell', status: 'running', pid: 22, startedAt: Date.now(),
    });
    const previousFolders = [...(vscode.workspace.workspaceFolders ?? [])];
    vscode.workspace.workspaceFolders?.splice(0, Infinity, { uri: vscode.Uri.file(process.cwd()) });
    try {
      const tool = makeShellTool();
      await expect(tool.handler({ command: 'echo hi', notify_on_exit: true }, { beforeMutate: () => {} }))
        .rejects.toThrow('requires background=true');
      await expect(tool.handler({ command: 'echo hi', background: true, notify_on_exit: true }, { beforeMutate: () => {} }))
        .rejects.toThrow('requires a conversation');
      await tool.handler({ command: 'echo hi', background: true, notify_on_exit: true }, {
        beforeMutate: () => {}, conversationId: 'the-chat',
      });
      expect(startSpy).toHaveBeenCalledWith(expect.objectContaining({ notifyConversationId: 'the-chat' }));
    } finally {
      startSpy.mockRestore();
      vscode.workspace.workspaceFolders?.splice(0, Infinity, ...previousFolders);
    }
  });

  it('routes notices to the inbox when reserved and sends them when idle', () => {
    const notice = {
      id: 'exec-test', conversationId: 'chat', command: 'pwsh', args: ['-Command', 'Get-Date'],
      status: 'completed' as const, exitCode: 0, error: undefined, durationMs: 1000,
      stdoutTail: 'changed', stderrTail: '',
    };
    const addTell = vi.fn();
    const send = vi.fn();
    const log = vi.fn();
    routeSidebarPrompt('notice', { conversationId: 'chat', tellId: 'chip-1' }, 'active', () => true, addTell, send);
    expect(addTell).toHaveBeenCalledWith('chat', 'notice', false, 'chip-1', undefined);
    deliverBackgroundExitNotice(notice, () => true, (text, id, echo, internal) => {
      routeSidebarPrompt(text, { conversationId: id }, 'active', () => false, addTell, send, echo, internal);
    }, log);
    expect(send).toHaveBeenCalledWith(expect.stringContaining('not a message from the user'), undefined, 'chat', false, true);
    deliverBackgroundExitNotice(notice, () => false, send, log);
    expect(send).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledOnce();
  });

  it('lists only this chat’s running execution ids, commands, and elapsed times', () => {
    const listRunningForConversation = vi.fn((id: string) => id === 'chat-a' ? [{
      id: 'exec-abc', command: 'python', args: ['-m', 'http.server'], cwd: '.',
      status: 'running' as const, pid: 40, startedAt: 10_000,
      finishedAt: undefined, exitCode: null,
    }] : []);
    const fakeManager = { listRunningForConversation };

    expect(runningBackgroundExecutionsNotice('chat-a', 135_000, fakeManager)).toContain(
      'exec-abc: python -m http.server (running 2m 05s)',
    );
    expect(runningBackgroundExecutionsNotice('chat-b', 135_000, fakeManager)).toBeUndefined();
  });

  it('lists and stops background executions through their native tools', async () => {
    const start = backgroundExecutionManager.start({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
    });
    const listed = JSON.parse(String(await makeListExecutionsTool().handler({}))) as {
      executions: Array<{ execution_id: string }>;
    };
    expect(listed.executions.some((execution) => execution.execution_id === start.id)).toBe(true);
    const stopped = JSON.parse(String(await makeStopExecutionTool().handler({ execution_id: start.id }))) as {
      status: string;
    };
    expect(stopped.status).toBe('terminated');
  });

  // Everything below is the 2026-10-30 change: the wake is on by default, and a
  // stopped turn silences it. The exit listener IS the wake — backgroundExitNotice
  // routes its text, and a route to an idle chat starts a turn — so "the listener
  // was not called" is the same thing as "the chat did not restart by itself".
  const executionIdOf = (result: unknown): string =>
    String(result)
      .split('\n')[0]!
      .replace('execution_id: ', '');

  const inWorkspace = async <T>(run: () => Promise<T>): Promise<T> => {
    const previousFolders = [...(vscode.workspace.workspaceFolders ?? [])];
    vscode.workspace.workspaceFolders?.splice(0, Infinity, { uri: vscode.Uri.file(process.cwd()) });
    try {
      return await run();
    } finally {
      vscode.workspace.workspaceFolders?.splice(0, Infinity, ...previousFolders);
    }
  };

  const waitUntilFinishedOn = async (
    target: BackgroundExecutionManager,
    id: string,
  ): Promise<void> =>
    vi.waitFor(
      () =>
        expect(target.list().find((item) => item.id === id)?.status ?? 'running').not.toBe('running'),
      { timeout: 10_000 },
    );

  it('wakes the chat for a background command started with no flag (the new default)', async () => {
    const listener = vi.fn();
    const subscription = backgroundExecutionManager.onNotifiedExit(listener);
    try {
      await inWorkspace(async () => {
        await makeShellTool().handler(
          { command: 'echo armed', background: true },
          { beforeMutate: () => {}, conversationId: 'wake-chat' },
        );
        await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1), { timeout: 10_000 });
      });
    } finally {
      subscription.dispose();
    }
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      conversationId: 'wake-chat',
      status: 'completed',
    });
  });

  it('does not wake a chat that passed notify_on_exit: false', async () => {
    const listener = vi.fn();
    const subscription = backgroundExecutionManager.onNotifiedExit(listener);
    try {
      await inWorkspace(async () => {
        const started = await makeShellTool().handler(
          { command: 'echo quiet', background: true, notify_on_exit: false },
          { beforeMutate: () => {}, conversationId: 'silent-chat' },
        );
        const id = executionIdOf(started);
        expect(backgroundExecutionManager.list().some((item) => item.id === id)).toBe(true);
        await waitUntilFinishedOn(backgroundExecutionManager, id);
      });
    } finally {
      subscription.dispose();
    }
    expect(listener).not.toHaveBeenCalled();
  });

  it('errors nothing and arms nothing when there is no chat to wake', async () => {
    const startSpy = vi.spyOn(backgroundExecutionManager, 'start').mockReturnValue({
      id: 'exec-no-chat',
      status: 'running',
      pid: 22,
      startedAt: Date.now(),
    });
    try {
      await inWorkspace(async () => {
        await expect(
          makeShellTool().handler({ command: 'echo hi', background: true }, { beforeMutate: () => {} }),
        ).resolves.toContain('exec-no-chat');
        expect(startSpy.mock.calls[0]?.[0]).not.toHaveProperty('notifyConversationId');
      });
    } finally {
      startSpy.mockRestore();
    }
  });

  it('a scheduled job run keeps the opt-in default, and an explicit flag still arms it', async () => {
    const startSpy = vi.spyOn(backgroundExecutionManager, 'start').mockReturnValue({
      id: 'exec-job',
      status: 'running',
      pid: 22,
      startedAt: Date.now(),
    });
    const marker = unattendedConversations.mark('job-chat', {
      jobId: 'job-7',
      jobName: 'morning check',
    });
    try {
      await inWorkspace(async () => {
        const tool = makeShellTool();
        await tool.handler(
          { command: 'echo hi', background: true },
          { beforeMutate: () => {}, conversationId: 'job-chat' },
        );
        expect(startSpy.mock.calls[0]?.[0]).not.toHaveProperty('notifyConversationId');
        startSpy.mockClear();
        await tool.handler(
          { command: 'echo hi', background: true, notify_on_exit: true },
          { beforeMutate: () => {}, conversationId: 'job-chat' },
        );
        expect(startSpy.mock.calls[0]?.[0]).toMatchObject({ notifyConversationId: 'job-chat' });
      });
    } finally {
      marker.dispose();
      startSpy.mockRestore();
    }
  });

  it('a stopped turn silences only its own chat, and leaves the job running', async () => {
    const listener = vi.fn();
    const subscription = manager.onNotifiedExit(listener);
    const stopped = manager.start({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(0), 200)'],
      cwd: process.cwd(),
      notifyConversationId: 'stopped-chat',
    });
    const other = manager.start({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(0), 300)'],
      cwd: process.cwd(),
      notifyConversationId: 'other-chat',
    });
    try {
      manager.disarmNotify('stopped-chat');
      // Still running and still listed: Stop silences the wake, it does not
      // kill the job or hide it from the next turn's running-jobs notice.
      expect(manager.listRunningForConversation('stopped-chat')).toHaveLength(1);
      await waitUntilFinishedOn(manager, stopped.id);
      await waitUntilFinishedOn(manager, other.id);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0]?.[0]).toMatchObject({
        id: other.id,
        conversationId: 'other-chat',
      });
    } finally {
      subscription.dispose();
    }
  });

  it('stays silent when monitor_execution already saw the end', async () => {
    const listener = vi.fn();
    const subscription = backgroundExecutionManager.onNotifiedExit(listener);
    const started = backgroundExecutionManager.start({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(0), 200)'],
      cwd: process.cwd(),
      notifyConversationId: 'watched-chat',
    });
    try {
      const observed = JSON.parse(
        String(await makeMonitorExecutionTool().handler({ execution_id: started.id, wait_ms: 3_000 })),
      ) as { status: string };
      expect(observed.status).not.toBe('running');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(listener).not.toHaveBeenCalled();
    } finally {
      subscription.dispose();
    }
  });

  const sendAsKind = async (kind: 'cancelled' | 'interrupted' | 'completed'): Promise<void> => {
    const conv = {
      id: 'conv-1',
      title: 'Tab',
      messages: [],
      createdAt: 0,
      updatedAt: 0,
      archived: false,
      active_model: null,
    } as unknown as ConversationRuntime;
    const turns: Record<string, unknown> = {
      cancelled: { kind: 'cancelled', finalText: '' },
      interrupted: { kind: 'interrupted', finalText: 'partial' },
      completed: { kind: 'completed', finalText: 'ok', finishReason: 'stop' },
    };
    const deps: SendPipelineDeps = {
      getConfig: () =>
        ({ active_model: 'qwen', models: [{ name: 'qwen' }] }) as unknown as ForgeConfig,
      getSidebar: () =>
        ({ activeConversationId: conv.id, conversations: [conv] }) as unknown as SidebarRuntime,
      getActive: () => conv,
      agentLoop: {
        isStreamingConv: () => false,
        isCancellationPending: () => false,
        waitForCancelledTurns: async () => undefined,
        runTurn: async () => turns[kind] as ForgeTurnOutcome,
      } as unknown as SendPipelineDeps['agentLoop'],
      requestChains: new RequestChainLifecycle(),
      events: { onBackendError: vi.fn() },
      post: vi.fn(),
      persistSession: vi.fn(),
      postSessionSync: vi.fn(),
      evaluateAfterTurn: async () => undefined,
      resetContextWarning: vi.fn(),
      midTurnInbox: new MidTurnInbox(),
    };
    await new SendPipeline(deps).send('a prompt');
  };

  it('a cancelled turn disarms the wake; an interrupted or completed one keeps it', async () => {
    const disarm = vi
      .spyOn(backgroundExecutionManager, 'disarmNotify')
      .mockImplementation(() => undefined);
    try {
      await sendAsKind('cancelled');
      expect(disarm).toHaveBeenCalledWith('conv-1');
      disarm.mockClear();
      await sendAsKind('interrupted');
      expect(disarm).not.toHaveBeenCalled();
      disarm.mockClear();
      await sendAsKind('completed');
      expect(disarm).not.toHaveBeenCalled();
    } finally {
      disarm.mockRestore();
    }
  });

  it('the descriptions say the wake is on by default, how to opt out, and when it will not come', () => {
    expect(NOTIFY_ON_EXIT_DESCRIPTION).toMatch(/^On by default with background=true/u);
    expect(NOTIFY_ON_EXIT_DESCRIPTION).toMatch(/pass false to opt out/u);
    expect(NOTIFY_ON_EXIT_DESCRIPTION).toMatch(/owner stopped the turn/u);
    // The U15-10 negative cases: a model that expects a notice that never comes
    // waits forever, so every case that sends none has to stay named.
    expect(NOTIFY_ON_EXIT_DESCRIPTION).toMatch(/window reloads/u);
    expect(NOTIFY_ON_EXIT_DESCRIPTION).toMatch(/you stop the job/u);
    expect(NOTIFY_ON_EXIT_DESCRIPTION).toMatch(/monitor_execution already saw it end/u);
    expect(NOTIFY_ON_EXIT_DESCRIPTION).not.toMatch(/^Only with background=true\./u);
    expect(makeMonitorExecutionTool().definition.function.description).toMatch(
      /wakes the chat on its own/u,
    );
  });
});
