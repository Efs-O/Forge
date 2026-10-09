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
import { makeListExecutionsTool, makeStopExecutionTool } from '../../src/tools/backgroundExecutionTools';
import { runningBackgroundExecutionsNotice, deliverBackgroundExitNotice, routeSidebarPrompt } from '../../src/sidebar/backgroundExitNotice';

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
    manager.start({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("x".repeat(3000))'],
      cwd: process.cwd(),
      notifyConversationId: 'chat',
    });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ conversationId: 'chat', status: 'completed' });
    expect(listener.mock.calls[0]?.[0].stdoutTail).toHaveLength(2_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
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
    expect(addTell).toHaveBeenCalledWith('chat', 'notice', false, 'chip-1');
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
});
