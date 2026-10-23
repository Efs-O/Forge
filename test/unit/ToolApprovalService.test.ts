import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ commands: { executeCommand: vi.fn() } }));

import type { HostToWebview } from '../../src/sidebar/messageBridge';
import {
  ToolApprovalPolicyDenied,
  ToolApprovalService,
} from '../../src/sidebar/ToolApprovalService';
import { unattendedConversations } from '../../src/sidebar/unattendedConversations';

describe('ToolApprovalService', () => {
  afterEach(() => vi.useRealTimers());

  it('never bypasses dangerous cloud egress approval in clanker mode', async () => {
    const posted: HostToWebview[] = [];
    const service = new ToolApprovalService(
      (message) => posted.push(message),
      () => ({}) as never,
    );
    service.setClankerMode(true);
    await expect(service.request('write_file', 'safe')).resolves.toBe('approved');
    await expect(
      service.request('delete_file', 'recycle-bin move', false, 'conv'),
    ).resolves.toBe('approved');
    const pending = service.request('budget_test_tool', 'cloud egress', true, 'conv');
    const request = posted.find((message) => message.type === 'confirmRequest');
    expect(request).toMatchObject({
      type: 'confirmRequest',
      toolName: 'budget_test_tool',
      isDangerous: true,
    });
    if (request?.type !== 'confirmRequest') throw new Error('confirmation was not posted');
    service.resolve(request.id, false);
    await expect(pending).resolves.toBe('declined');

    const permanentDelete = service.request('delete_file', 'permanent delete', true, 'conv');
    const permanentCard = posted
      .filter((message) => message.type === 'confirmRequest' && message.toolName === 'delete_file')
      .at(-1);
    if (permanentCard?.type !== 'confirmRequest')
      throw new Error('permanent delete approval was not posted');
    expect(permanentCard.isDangerous).toBe(true);
    service.resolve(permanentCard.id, false);
    await expect(permanentDelete).resolves.toBe('declined');
  });

  it('denies a dangerous unattended action without prompting or changing clanker mode', async () => {
    const posted: HostToWebview[] = [];
    const service = new ToolApprovalService(
      (message) => posted.push(message),
      () => ({}) as never,
    );
    const marker = unattendedConversations.mark('job-conversation', { jobId: 'j1', jobName: 'Job' });
    try {
      service.setClankerMode(true);
      await expect(
        service.request('install_llamacpp', 'switch config', true, 'job-conversation'),
      ).rejects.toMatchObject({
        name: 'ToolApprovalPolicyDenied',
        message: expect.stringContaining('RESULT: failed'),
      });
      expect(posted.some((message) => message.type === 'confirmRequest')).toBe(false);
      expect(service.getClankerMode()).toBe(true);
      expect(new ToolApprovalPolicyDenied('x').message).toContain('policy');
    } finally {
      marker.dispose();
    }
  });

  it('tells an unattended bus turn to carry on rather than report a job RESULT', async () => {
    const service = new ToolApprovalService(() => undefined, () => ({}) as never);
    const marker = unattendedConversations.mark('bus-conversation');
    try {
      const denied = service.request('shell', 'rm -rf build', true, 'bus-conversation');
      await expect(denied).rejects.toMatchObject({ name: 'ToolApprovalPolicyDenied' });
      const message = await denied.catch((err: Error) => err.message);
      expect(message).toContain('do not retry it');
      expect(message).not.toContain('RESULT');
    } finally {
      marker.dispose();
    }
  });

  it('auto-approves only the non-dangerous call in the registered conversation', async () => {
    const posted: HostToWebview[] = [];
    const service = new ToolApprovalService(
      (message) => posted.push(message),
      () => ({}) as never,
    );
    const marker = unattendedConversations.mark('unattended-conversation');
    try {
      await expect(
        service.request('edit_file', 'config.yaml', false, 'unattended-conversation'),
      ).resolves.toBe('approved');
      await expect(
        service.request('delete_file', 'recycle-bin move', false, 'unattended-conversation'),
      ).resolves.toBe('approved');
      await expect(
        service.request('delete_file', 'permanent delete', true, 'unattended-conversation'),
      ).rejects.toMatchObject({ name: 'ToolApprovalPolicyDenied' });

      const attended = service.request('edit_file', 'config.yaml', false, 'attended-conversation');
      const request = posted.find(
        (message) => message.type === 'confirmRequest' && message.conversationId === 'attended-conversation',
      );
      expect(request).toBeDefined();
      if (request?.type !== 'confirmRequest') throw new Error('attended confirmation was not posted');
      service.resolve(request.id, true);
      await expect(attended).resolves.toBe('approved');
    } finally {
      marker.dispose();
    }
  });

  it('announces a remotely set clanker mode to the webview', () => {
    const posted: HostToWebview[] = [];
    const service = new ToolApprovalService(
      (message) => posted.push(message),
      () => ({}) as never,
    );
    // The remote /clanker path calls setClankerMode, not toggleClankerMode.
    service.setClankerMode(true);
    service.setClankerMode(true);
    service.setClankerMode(false);
    expect(posted.filter((message) => message.type === 'clankerChanged')).toEqual([
      { type: 'clankerChanged', enabled: true },
      { type: 'clankerChanged', enabled: false },
    ]);
  });

  it('tells the webview to drop a dialog a sink resolved', async () => {
    const posted: HostToWebview[] = [];
    const service = new ToolApprovalService(
      (message) => posted.push(message),
      () => ({}) as never,
    );
    const pending = service.request('edit_file', 'README.md', false, 'conv');
    const request = posted.find((message) => message.type === 'confirmRequest');
    if (request?.type !== 'confirmRequest') throw new Error('confirmation was not posted');
    // Stands in for a remote transport button: the webview never clicked.
    service.resolve(request.id, true);
    await expect(pending).resolves.toBe('approved');
    expect(posted).toContainEqual({ type: 'confirmResolved', id: request.id });
  });

  it('queues approvals and cancels every approval for a conversation', async () => {
    const service = new ToolApprovalService(
      () => {},
      () => ({}) as never,
    );
    const first = service.request('write_file', 'one', false, 'conv');
    const second = service.request('write_file', 'two', false, 'conv');
    service.cancelConversation('conv');
    await expect(first).resolves.toBe('declined');
    await expect(second).resolves.toBe('declined');
  });

  it('reports approval lifecycle for queued items from enqueue to resolution', async () => {
    const lifecycle: string[] = [];
    const service = new ToolApprovalService(
      () => {},
      () => ({}) as never,
    );
    service.setApprovalLifecycle(
      (conversationId) => lifecycle.push(`start:${conversationId}`),
      (conversationId) => lifecycle.push(`end:${conversationId}`),
    );

    const first = service.request('write_file', 'one', false, 'conv-1');
    const second = service.request('write_file', 'two', false, 'conv-2');
    service.cancelConversation('conv-2');
    service.cancelConversation('conv-1');
    await expect(first).resolves.toBe('declined');
    await expect(second).resolves.toBe('declined');

    expect(lifecycle).toEqual(['start:conv-1', 'start:conv-2', 'end:conv-2', 'end:conv-1']);
  });

  it('supports a non-webview sink and dismisses every surface on first resolution', async () => {
    const requested = vi.fn();
    const resolved = vi.fn();
    const service = new ToolApprovalService(
      () => undefined,
      () => undefined,
    );
    service.addSink({ requested, resolved });
    const pending = service.request('write_file', 'src/a.ts', false, 'conv');
    expect(requested).toHaveBeenCalledOnce();
    const id = requested.mock.calls[0]?.[0].id as string;
    service.resolve(id, true);
    service.resolve(id, false);
    await expect(pending).resolves.toBe('approved');
    expect(resolved).toHaveBeenCalledOnce();
    expect(resolved).toHaveBeenCalledWith(
      expect.objectContaining({ id, approved: true, reason: 'resolved' }),
    );
  });

  it('waits indefinitely when no approval timeout is configured', async () => {
    vi.useFakeTimers();
    const posted: HostToWebview[] = [];
    const service = new ToolApprovalService(
      (message) => posted.push(message),
      () => ({}) as never,
      undefined,
      () => undefined,
    );
    const pending = service.request('write_file', 'src/file.ts', true, 'conv');
    let settled = false;
    void pending.then(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);

    expect(settled).toBe(false);
    const request = posted.find((message) => message.type === 'confirmRequest');
    if (request?.type !== 'confirmRequest') throw new Error('confirmation was not posted');
    service.resolve(request.id, true);
    await expect(pending).resolves.toBe('approved');
  });

  it('times out an unanswered approval and emits the timeout resolution reason', async () => {
    vi.useFakeTimers();
    const resolved = vi.fn();
    const posted: HostToWebview[] = [];
    const service = new ToolApprovalService(
      (message) => posted.push(message),
      () => ({}) as never,
      undefined,
      () => 1,
    );
    service.addSink({ requested: vi.fn(), resolved });
    const baseline = vi.getTimerCount();
    const pending = service.request('delete_file', 'result/', true, 'conv');

    await vi.advanceTimersByTimeAsync(60_000);

    await expect(pending).resolves.toEqual({ kind: 'timeout', minutes: 1 });
    expect(resolved).toHaveBeenCalledWith(
      expect.objectContaining({ approved: false, reason: 'timeout', toolName: 'delete_file' }),
    );
    expect(posted.some((message) => message.type === 'confirmResolved')).toBe(true);
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it('latches timeout for one conversation until its next turn', async () => {
    vi.useFakeTimers();
    const posted: HostToWebview[] = [];
    const service = new ToolApprovalService(
      (message) => posted.push(message),
      () => ({}) as never,
      undefined,
      () => 1,
    );
    const first = service.request('write_file', 'one', true, 'conv-1');
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(first).resolves.toEqual({ kind: 'timeout', minutes: 1 });

    await expect(service.request('write_file', 'two', true, 'conv-1')).resolves.toEqual({
      kind: 'timeout',
      minutes: 1,
    });
    expect(
      posted.filter((message) => message.type === 'confirmRequest' && message.conversationId === 'conv-1'),
    ).toHaveLength(1);
    const other = service.request('write_file', 'other chat', true, 'conv-2');
    expect(service.pending()?.conversationId).toBe('conv-2');
    service.beginTurn('conv-1');
    const nextTurn = service.request('write_file', 'next turn', true, 'conv-1');
    let nextTurnSettled = false;
    void nextTurn.then(() => { nextTurnSettled = true; });
    expect(nextTurnSettled).toBe(false);

    const active = posted.find(
      (message) => message.type === 'confirmRequest' && message.conversationId === 'conv-2',
    );
    if (active?.type !== 'confirmRequest') throw new Error('other conversation was not prompted');
    service.resolve(active.id, true);
    await expect(other).resolves.toBe('approved');
    const later = posted
      .filter((message) => message.type === 'confirmRequest' && message.conversationId === 'conv-1')
      .at(-1);
    if (later?.type !== 'confirmRequest') throw new Error('next turn was not prompted');
    service.resolve(later.id, true);
    await expect(nextTurn).resolves.toBe('approved');
  });

  it('clears a conversation timeout latch when that conversation is disposed', async () => {
    vi.useFakeTimers();
    const service = new ToolApprovalService(() => undefined, () => ({}) as never, undefined, () => 1);
    service.addSink({ requested: vi.fn(), resolved: vi.fn() });
    const first = service.request('write_file', 'first', true, 'conv');
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(first).resolves.toEqual({ kind: 'timeout', minutes: 1 });

    service.clearConversationState('conv');
    const next = service.request('write_file', 'after close', true, 'conv');
    expect(service.pending()?.detail).toBe('after close');
    const pending = service.pending();
    if (!pending) throw new Error('conversation disposal did not clear its timeout latch');
    service.resolve(pending.id, true);
    await expect(next).resolves.toBe('approved');
  });

  it('starts queued approval timeouts at request time', async () => {
    vi.useFakeTimers();
    let minutes = 2;
    const service = new ToolApprovalService(
      () => undefined,
      () => ({}) as never,
      undefined,
      () => minutes,
    );
    service.addSink({ requested: vi.fn(), resolved: vi.fn() });
    const active = service.request('write_file', 'active', true, 'first');
    minutes = 1;
    const queued = service.request('write_file', 'queued', true, 'second');

    await vi.advanceTimersByTimeAsync(60_000);

    await expect(queued).resolves.toEqual({ kind: 'timeout', minutes: 1 });
    expect(service.pending()?.conversationId).toBe('first');
    const request = service.pending();
    if (!request) throw new Error('first approval was not active');
    service.resolve(request.id, true);
    await expect(active).resolves.toBe('approved');
  });

  it('reads a changed timeout setting for each new approval', async () => {
    vi.useFakeTimers();
    let minutes: number | undefined = 1;
    const service = new ToolApprovalService(
      () => undefined,
      () => ({}) as never,
      undefined,
      () => minutes,
    );
    service.addSink({ requested: vi.fn(), resolved: vi.fn() });
    const first = service.request('write_file', 'first', true, 'conv');
    const firstRequest = service.pending();
    if (!firstRequest) throw new Error('first approval was not active');
    service.resolve(firstRequest.id, true);
    await expect(first).resolves.toBe('approved');

    minutes = 2;
    const second = service.request('write_file', 'second', true, 'conv');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.pending()?.detail).toBe('second');
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(second).resolves.toEqual({ kind: 'timeout', minutes: 2 });
  });

  it('clears timers on answer, cancel, abort, cancelAll, and dispose', async () => {
    vi.useFakeTimers();
    const settle = async (kind: 'answer' | 'cancel' | 'abort' | 'all' | 'dispose') => {
      const service = new ToolApprovalService(
        () => undefined,
        () => ({}) as never,
        undefined,
        () => 1,
      );
      const controller = new AbortController();
      const pending = service.request(
        'write_file',
        kind,
        true,
        'conv',
        kind === 'abort' ? controller.signal : undefined,
      );
      const active = service.pending();
      if (!active) throw new Error(`${kind} approval was not active`);
      if (kind === 'answer') service.resolve(active.id, true);
      else if (kind === 'cancel') service.cancelConversation('conv');
      else if (kind === 'abort') controller.abort();
      else if (kind === 'all') service.cancelAll();
      else service.dispose();
      await expect(pending).resolves.toBe(kind === 'answer' ? 'approved' : 'declined');
      expect(vi.getTimerCount()).toBe(0);
    };

    for (const kind of ['answer', 'cancel', 'abort', 'all', 'dispose'] as const) {
      await settle(kind);
    }
  });
});
