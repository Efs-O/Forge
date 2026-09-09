import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { ForgeConfig } from '../../src/config/types';
import { LocalDelegationService } from '../../src/delegation/LocalDelegationService';
import type { CliAgentDriver } from '../../src/agents/CliAgentDriver';
import { PREFERRED_CLI_DELEGATION_REPLY_CHARS } from '../../src/delegation/limits';

vi.mock('vscode', () => ({
  workspace: { workspaceFolders: [{ uri: { fsPath: path.resolve('/workspace') } }] },
  window: {
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
  },
}));

const root = path.resolve('/workspace');

const config = (): ForgeConfig => ({
  models: [{ name: 'claude-code', provider: 'cli', cli: process.execPath }],
  active_model: 'primary',
  llama_server: {},
});

const service = (run: CliAgentDriver['run']): LocalDelegationService =>
  new LocalDelegationService({
    getConfig: config,
    workspaceRoot: root,
    backendPool: { canDelegate: vi.fn(), acquireForDelegation: vi.fn() },
    cliDriver: { run } as unknown as CliAgentDriver,
  });

describe('the reply-shape contract sent to a CLI delegate', () => {
  it('asks for a short verdict and a REPORT path for the detail', async () => {
    const run = vi.fn(async () => ({ status: 'completed' as const, finalText: 'APPROVE' }));
    await service(run).ask({
      primaryModel: 'primary',
      targetModel: 'claude-code',
      task: 'review the plan',
    });
    const task = run.mock.calls[0][0].task as string;
    expect(task).toContain(String(PREFERRED_CLI_DELEGATION_REPLY_CHARS));
    expect(task).toContain('REPORT: <path>');
    // The exception: an edit task's deliverable is the edit, not a report file.
    expect(task).toContain('those edits ARE the deliverable');
  });
});

describe('a CLI delegation that does not complete', () => {
  // A CLI delegate runs unrestricted against the real workspace. On 2026-09-09
  // Claude Code edited the plan file it was asked to revise and then hit the
  // 600s ceiling; the caller was told only "timed out" and had to infer from
  // file mtimes that any work had happened.
  it('hands back the partial output instead of discarding it', async () => {
    const run = vi.fn(async () => ({
      status: 'timeout' as const,
      finalText: 'I revised section 3 of the plan and',
      error: 'timed out after 600000ms',
    }));
    await expect(
      service(run).ask({ primaryModel: 'primary', targetModel: 'claude-code', task: 'revise' }),
    ).rejects.toThrow(/I revised section 3 of the plan and/);
  });

  it('tells the caller the work may already be done', async () => {
    const run = vi.fn(async () => ({
      status: 'timeout' as const,
      finalText: '',
      error: 'timed out after 600000ms',
    }));
    await expect(
      service(run).ask({ primaryModel: 'primary', targetModel: 'claude-code', task: 'revise' }),
    ).rejects.toThrow(/git status/);
  });
});
