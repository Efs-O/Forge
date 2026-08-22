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
});
