import { describe, expect, it } from 'vitest';
import {
  codexAppServerArgs,
  codexThreadResumeParams,
  codexThreadStartParams,
} from '../../src/agents/codexAppServerArgs';

describe('codexAppServerArgs', () => {
  it('is byte-identical to today when no effort is set (Side change A)', () => {
    expect(codexAppServerArgs({ executable: 'codex' })).toEqual([
      'app-server',
      '--stdio',
      '-c',
      'analytics.enabled=false',
      '-c',
      'sandbox_mode="danger-full-access"',
      '-c',
      'approval_policy="never"',
    ]);
  });

  it('appends -c model_reasoning_effort="<v>" only when effort is set', () => {
    expect(codexAppServerArgs({ executable: 'codex', effort: 'high' })).toEqual([
      'app-server',
      '--stdio',
      '-c',
      'analytics.enabled=false',
      '-c',
      'sandbox_mode="danger-full-access"',
      '-c',
      'approval_policy="never"',
      '-c',
      'model_reasoning_effort="high"',
    ]);
  });

  it('keeps argsPrefix and effort composing together', () => {
    const args = codexAppServerArgs({ executable: 'codex', argsPrefix: ['--foo'], effort: 'xhigh' });
    expect(args[0]).toBe('--foo');
    expect(args).toContain('model_reasoning_effort="xhigh"');
  });
});

describe('codexThreadStartParams', () => {
  it('is unchanged: effort never reaches thread/start (process-level -c only)', () => {
    expect(codexThreadStartParams('/ws')).toEqual({
      cwd: '/ws',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      ephemeral: false,
    });
    expect(codexThreadStartParams('/ws', 'gpt-6-luna')).toEqual({
      cwd: '/ws',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      ephemeral: false,
      model: 'gpt-6-luna',
    });
  });
});

describe('codexThreadResumeParams', () => {
  it('is byte-identical to today when neither key is set', () => {
    expect(codexThreadResumeParams('th-1')).toEqual({ threadId: 'th-1' });
  });

  it('re-applies the model on resume — the fix for config never reaching a resumed thread', () => {
    expect(codexThreadResumeParams('th-1', 'gpt-6-luna')).toEqual({
      threadId: 'th-1',
      model: 'gpt-6-luna',
    });
  });

  it('routes effort through config.model_reasoning_effort, the only non-experimental path', () => {
    expect(codexThreadResumeParams('th-1', undefined, 'xhigh')).toEqual({
      threadId: 'th-1',
      config: { model_reasoning_effort: 'xhigh' },
    });
  });

  it('carries both together', () => {
    expect(codexThreadResumeParams('th-1', 'gpt-6-sol', 'medium')).toEqual({
      threadId: 'th-1',
      model: 'gpt-6-sol',
      config: { model_reasoning_effort: 'medium' },
    });
  });
});
