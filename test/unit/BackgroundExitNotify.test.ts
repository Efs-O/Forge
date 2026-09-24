import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundExecutionManager } from '../../src/tools/BackgroundExecutionManager';
import { makeExecCommandTool, makeRunBuildTool } from '../../src/tools/execTools';
import { MidTurnInbox } from '../../src/agent/MidTurnInbox';
import { makeWaitTool } from '../../src/tools/waitTool';
import { checkPowerShellBan, checkShellOperators } from '../../src/tools/execHelpers';
import { resolveExecInvocation } from '../../src/tools/execProgramResolver';
import { backgroundExecutionManager } from '../../src/tools/BackgroundExecutionManager';
import type { BackgroundExecutionObservation } from '../../src/tools/BackgroundExecutionManager';
import { deliverBackgroundExitNotice, routeSidebarPrompt } from '../../src/sidebar/backgroundExitNotice';
import { checkDenyList, getBuiltinDenyList } from '../../src/tools/DenyList';
import * as vscode from 'vscode';

describe('background exit notification', () => {
  const manager = new BackgroundExecutionManager();
  afterEach(() => manager.dispose());

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
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      conversationId: 'chat',
      status: 'completed',
    });
    expect(listener.mock.calls[0]?.[0].stdoutTail).toHaveLength(2_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not notify after stop, terminal observation, or disposal', async () => {
    const listener = vi.fn();
    manager.onNotifiedExit(listener);
    const stopped = manager.start({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      notifyConversationId: 'chat',
    });
    await manager.stop(stopped.id);
    const observed = manager.start({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwd: process.cwd(),
      notifyConversationId: 'chat',
    });
    await manager.observe(observed.id, 2000, 0, 0);
    const disposed = manager.start({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      notifyConversationId: 'chat',
    });
    void disposed;
    manager.dispose();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(listener).not.toHaveBeenCalled();
  });

  it('validates notify_on_exit and passes the chat id to both tools', async () => {
    await expect(makeExecCommandTool().handler({
      command: process.execPath,
      args: ['-e', ''],
      notify_on_exit: true,
    }, { beforeMutate: () => {} })).rejects.toThrow('requires background: true');
    await expect(makeRunBuildTool().handler({ notify_on_exit: true }, { beforeMutate: () => {} }))
      .rejects.toThrow('requires background: true');
    await expect(makeExecCommandTool().handler({
      command: process.execPath,
      args: ['-e', ''],
      background: true,
      notify_on_exit: true,
    }, { beforeMutate: () => {} })).rejects.toThrow('requires a conversation');

    const listener = vi.fn();
    const subscription = backgroundExecutionManager.onNotifiedExit(listener);
    const previousFolders = [...(vscode.workspace.workspaceFolders ?? [])];
    vscode.workspace.workspaceFolders?.splice(0, Infinity, { uri: vscode.Uri.file(process.cwd()) });
    try {
      await makeExecCommandTool().handler({
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        background: true,
        notify_on_exit: true,
      }, { beforeMutate: () => {}, conversationId: 'the-chat' });
      await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
      expect(listener.mock.calls[0]?.[0].conversationId).toBe('the-chat');
      const startSpy = vi.spyOn(backgroundExecutionManager, 'start').mockReturnValue({
        id: 'exec-build', status: 'running', pid: 1, startedAt: Date.now(),
      });
      const observation: BackgroundExecutionObservation = {
        id: 'exec-build', command: 'npm', status: 'running', pid: 1, startedAt: Date.now(),
        finishedAt: undefined, exitCode: null, error: undefined, stdout: '', stderr: '',
        stdoutStart: 0, stderrStart: 0, stdoutEnd: 0, stderrEnd: 0,
        stdoutOldest: 0, stderrOldest: 0, stdoutDropped: 0, stderrDropped: 0,
      };
      const observeSpy = vi.spyOn(backgroundExecutionManager, 'observe').mockResolvedValue(observation);
      await makeRunBuildTool().handler({
        script: 'type-check',
        background: true,
        notify_on_exit: true,
      }, { beforeMutate: () => {}, conversationId: 'build-chat' });
      expect(startSpy).toHaveBeenCalledWith(expect.objectContaining({
        notifyConversationId: 'build-chat',
      }));
      startSpy.mockRestore();
      observeSpy.mockRestore();
    } finally {
      vscode.workspace.workspaceFolders?.splice(0, Infinity, ...previousFolders);
      subscription.dispose();
    }
  });

  it('allows the documented pwsh -File invocation through the guards and resolver', () => {
    const args = ['-NoProfile', '-File', 'watch.ps1'];
    expect(checkDenyList('pwsh', args, getBuiltinDenyList())).toBeNull();
    expect(() => checkShellOperators(args)).not.toThrow();
    expect(() => checkPowerShellBan('pwsh', ['-NoProfile', '-File', 'watch.ps1'])).not.toThrow();
    expect(resolveExecInvocation('pwsh', args)).toEqual({
      command: 'pwsh',
      args,
    });
    expect(() => checkPowerShellBan('pwsh', ['-Command', 'Get-Process'])).toThrow();
  });

  it('wait returns early only for its own chat and unregisters the arrival listener', async () => {
    const inbox = new MidTurnInbox();
    const unsubscribe = vi.fn();
    const tool = makeWaitTool();
    const waiting = tool.handler({ seconds: 5 }, {
      beforeMutate: () => {},
      conversationId: 'one',
      tellArrived: (callback) => {
        const dispose = inbox.onAdded('one', callback);
        return () => { unsubscribe(); dispose(); };
      },
    });
    inbox.add('two', { id: 'a', text: 'other chat' });
    inbox.add('one', { id: 'b', text: 'same chat' });
    await expect(waiting).resolves.toMatch(/because a new message arrived/u);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('routes notices to the inbox when reserved, sends when idle, and drops missing chats', () => {
    const notice = {
      id: 'exec-test', conversationId: 'chat', command: 'pwsh', args: ['-File', 'watch.ps1'],
      status: 'completed' as const, exitCode: 0, error: undefined, durationMs: 1000,
      stdoutTail: 'changed', stderrTail: '',
    };
    const addTell = vi.fn();
    const send = vi.fn();
    const log = vi.fn();
    routeSidebarPrompt('notice', { conversationId: 'chat' }, 'active', () => true, addTell, send);
    expect(addTell).toHaveBeenCalledWith('chat', 'notice');
    expect(send).not.toHaveBeenCalled();

    deliverBackgroundExitNotice(notice, () => true, (text, id, echo) => {
      routeSidebarPrompt(text, { conversationId: id }, 'active', () => false, addTell, send, echo);
    }, log);
    expect(send).toHaveBeenCalledWith(expect.stringContaining('not a message from the user'), undefined, 'chat', true);
    deliverBackgroundExitNotice(notice, () => false, send, log);
    expect(send).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledOnce();
  });
});
