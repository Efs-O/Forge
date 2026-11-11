import type * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import type { ForgeConfig } from '../../src/config/types';
import type { JobStore } from '../../src/jobs/JobStore';
import { GateEventLog, type GateEventRow } from '../../src/sidebar/gateEventLog';
import { ToolApprovalPolicyDenied } from '../../src/sidebar/toolApprovalOutcome';
import { ToolApprovalService } from '../../src/sidebar/ToolApprovalService';
import { approvalCallOptions } from '../../src/sidebar/approvalCallOptions';
import { unattendedConversations } from '../../src/sidebar/unattendedConversations';
import { makeForgetTool } from '../../src/tools/memoryTools';
import { makeManageJobsTool } from '../../src/tools/jobTools';
import type { ToolApprovalMetadata } from '../../src/tools/toolContract';

const CONVERSATION = 'clanker-delete-test';

function setup(clanker: boolean) {
  const posted: Array<{ type: string; id?: string }> = [];
  const rows: GateEventRow[] = [];
  const service = new ToolApprovalService(
    (message) => posted.push(message as { type: string; id?: string }),
    () => ({}) as never,
  );
  service.addSink(new GateEventLog({ write: (row) => rows.push(row), now: () => 10_000 }));
  if (clanker) service.setClankerMode(CONVERSATION, true);
  return { posted, rows, service };
}

const forget = makeForgetTool({
  get: () => undefined,
  update: async () => undefined,
} as unknown as vscode.Memento);

// The delete card resolves the job, so the store holds the one it names.
const manageJobs = makeManageJobsTool({
  store: {
    root: 'jobs',
    loadAll: async () => [{ job: { id: 'nightly', name: 'Nightly' } }],
  } as unknown as JobStore,
  getConfig: () => ({ jobs: { enabled: true } }) as ForgeConfig,
});

const requests: Array<{ tool: string; metadata: ToolApprovalMetadata }> = [
  {
    tool: 'forget',
    metadata: forget.approval!({ key: 'favorite' })!,
  },
  {
    tool: 'manage_jobs',
    metadata: (await manageJobs.approval!({ action: 'delete', job: 'nightly' }))!,
  },
];

describe('Clanker answers memory and job deletion in attended chats', () => {
  it.each(requests)(
    'auto-approves and logs $tool with the human detail',
    async ({ tool, metadata }) => {
      const { rows, service } = setup(true);
      const outcome = await service.request(
        tool,
        metadata.detail ?? '',
        metadata.dangerous ?? false,
        CONVERSATION,
        undefined,
        approvalCallOptions(metadata, { card: true }, undefined, 'none'),
      );
      expect(outcome).toBe('approved');
      expect(rows[0]!.kind).toBe('auto');
      expect(rows[0]!.answered_by).toBe('clanker');
      expect(rows[0]!.reason).toBe(metadata.detail);
    },
  );

  it('names the job on the manage_jobs delete card', () => {
    expect(requests[1]!.metadata).toEqual({
      dangerous: true,
      detail: 'Delete job "Nightly" (nightly). Its definition, state, and run log are removed.',
      approvalKey: 'job-delete:nightly',
    });
  });

  it.each(requests)(
    'shows the normal approval card for $tool with Clanker off',
    async ({ tool, metadata }) => {
      const { posted, rows, service } = setup(false);
      const pending = service.request(
        tool,
        metadata.detail ?? '',
        metadata.dangerous ?? false,
        CONVERSATION,
        undefined,
        approvalCallOptions(metadata, { card: true }, undefined, 'none'),
      );
      const card = service.pending();
      expect(posted.some((message) => message.type === 'confirmRequest')).toBe(true);
      if (!card) throw new Error('approval card was not queued');
      service.resolve(card.id, 'approve');
      expect(await pending).toBe('approved');
      expect(rows[0]!.kind).toBe('card');
      expect(rows[0]!.reason).toBe(metadata.detail);
    },
  );
});

describe('job deletion stays dangerous in unattended turns', () => {
  it.each([
    ['unattended bus', undefined],
    ['job', { jobId: 'nightly', jobName: 'Nightly' }],
  ] as const)('refuses manage_jobs delete in %s turns', async (_kind, job) => {
    const marker = unattendedConversations.mark(CONVERSATION, job);
    try {
      const { posted, service } = setup(true);
      const metadata = (await manageJobs.approval!({ action: 'delete', job: 'nightly' }))!;
      await expect(
        service.request(
          'manage_jobs',
          metadata.detail ?? '',
          metadata.dangerous ?? false,
          CONVERSATION,
          undefined,
          approvalCallOptions(metadata, { card: true }, undefined, 'none'),
        ),
      ).rejects.toBeInstanceOf(ToolApprovalPolicyDenied);
      expect(posted.some((message) => message.type === 'confirmRequest')).toBe(false);
    } finally {
      marker.dispose();
    }
  });
});
