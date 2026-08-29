import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ commands: { executeCommand: vi.fn() } }));

import type { HostToWebview } from '../../src/sidebar/messageBridge';
import { ToolApprovalService } from '../../src/sidebar/ToolApprovalService';

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
