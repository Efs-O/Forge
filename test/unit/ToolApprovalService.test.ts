import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ commands: { executeCommand: vi.fn() } }));

import type { HostToWebview } from '../../src/sidebar/messageBridge';
import {
  ToolApprovalPolicyDenied,
  ToolApprovalService,
} from '../../src/sidebar/ToolApprovalService';
import { unattendedConversations } from '../../src/sidebar/unattendedConversations';

describe('ToolApprovalService', () => {
  it('never bypasses dangerous cloud-worker approval in clanker mode', async () => {
    const posted: HostToWebview[] = [];
    const service = new ToolApprovalService(
      (message) => posted.push(message),
      () => ({}) as never,
    );
    service.setClankerMode(true);
    await expect(service.request('write_file', 'safe')).resolves.toBe(true);
    const pending = service.request('run_terminal', 'cloud egress', true, 'conv');
    const request = posted.find((message) => message.type === 'confirmRequest');
    expect(request).toMatchObject({
      type: 'confirmRequest',
      toolName: 'run_terminal',
      isDangerous: true,
    });
    if (request?.type !== 'confirmRequest') throw new Error('confirmation was not posted');
    service.resolve(request.id, false);
    await expect(pending).resolves.toBe(false);
  });

  it('denies a dangerous unattended action without prompting or changing clanker mode', async () => {
    const posted: HostToWebview[] = [];
    const service = new ToolApprovalService(
      (message) => posted.push(message),
      () => ({}) as never,
    );
    const marker = unattendedConversations.mark('job-conversation');
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
      ).resolves.toBe(true);

      const attended = service.request('edit_file', 'config.yaml', false, 'attended-conversation');
      const request = posted.find(
        (message) => message.type === 'confirmRequest' && message.conversationId === 'attended-conversation',
      );
      expect(request).toBeDefined();
      if (request?.type !== 'confirmRequest') throw new Error('attended confirmation was not posted');
      service.resolve(request.id, true);
      await expect(attended).resolves.toBe(true);
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
    await expect(pending).resolves.toBe(true);
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
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
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
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);

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
    await expect(pending).resolves.toBe(true);
    expect(resolved).toHaveBeenCalledOnce();
    expect(resolved).toHaveBeenCalledWith(
      expect.objectContaining({ id, approved: true, reason: 'resolved' }),
    );
  });
});
