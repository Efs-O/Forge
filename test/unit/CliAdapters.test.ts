import { describe, expect, it } from 'vitest';
import { claudeAdapter } from '../../src/agents/adapters/claudeAdapter';
import { codexAdapter } from '../../src/agents/adapters/codexAdapter';
import { inferCliAgentName } from '../../src/agents/types';
import type { CliParseContext } from '../../src/agents/types';

function fakeContext() {
  const text: string[] = [];
  const status: string[] = [];
  let final: string | undefined;
  let error: string | undefined;
  let sessionId: string | undefined;
  const ctx: CliParseContext = {
    emitText: (t) => text.push(t),
    emitStatus: (t) => status.push(t),
    setFinal: (t) => {
      final = t;
    },
    setError: (t) => {
      error = t;
    },
    setSessionId: (id) => {
      sessionId = id;
    },
  };
  return { ctx, text, status, final: () => final, error: () => error, sessionId: () => sessionId };
}

describe('claudeAdapter', () => {
  it('builds argv with --permission-mode plan for read access', () => {
    expect(claudeAdapter.buildArgs('do it', 'read')).toEqual([
      '-p',
      'do it',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'plan',
    ]);
  });

  it('builds argv with --permission-mode acceptEdits for write access', () => {
    expect(claudeAdapter.buildArgs('do it', 'write')).toContain('acceptEdits');
  });

  it('uses bypassPermissions only for a full-access sidebar agent', () => {
    expect(claudeAdapter.buildArgs('do it', 'full')).toContain('bypassPermissions');
  });

  it('resumes the same session and selects the configured model', () => {
    const args = claudeAdapter.buildArgs('continue', 'full', {
      sessionId: 'session-1',
      model: 'opus',
    });
    expect(args).toContain('--resume');
    expect(args).toContain('session-1');
    expect(args).toContain('--model');
    expect(args).toContain('opus');
  });

  it('captures the persistent session id', () => {
    const state = fakeContext();
    claudeAdapter.handleLine(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-session' }),
      state.ctx,
    );
    expect(state.sessionId()).toBe('claude-session');
  });

  it('ignores non-JSON and unknown-type lines without throwing', () => {
    const { ctx, text } = fakeContext();
    expect(() => claudeAdapter.handleLine('not json', ctx)).not.toThrow();
    expect(() => claudeAdapter.handleLine('{"type":"system"}', ctx)).not.toThrow();
    expect(text).toEqual([]);
  });
});

describe('codexAdapter', () => {
  it('builds argv with --sandbox read-only for read access', () => {
    expect(codexAdapter.buildArgs('do it', 'read')).toEqual([
      'exec',
      'do it',
      '--json',
      '--sandbox',
      'read-only',
    ]);
  });

  it('builds argv with --sandbox workspace-write for write access', () => {
    expect(codexAdapter.buildArgs('do it', 'write')).toContain('workspace-write');
  });

  it('uses danger-full-access only for a full-access sidebar agent', () => {
    expect(codexAdapter.buildArgs('do it', 'full')).toContain('danger-full-access');
  });

  it('uses exec resume for an existing thread and selects the configured model', () => {
    expect(
      codexAdapter.buildArgs('continue', 'full', { sessionId: 'thread-1', model: 'gpt-5' }),
    ).toEqual(['exec', 'resume', 'thread-1', 'continue', '--json', '--model', 'gpt-5']);
  });

  it('captures the persistent thread id', () => {
    const state = fakeContext();
    codexAdapter.handleLine(
      JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread' }),
      state.ctx,
    );
    expect(state.sessionId()).toBe('codex-thread');
  });

  it('ignores non-JSON lines without throwing', () => {
    const { ctx } = fakeContext();
    expect(() => codexAdapter.handleLine('not json', ctx)).not.toThrow();
  });

  it('parses current item-based JSONL agent messages', () => {
    const state = fakeContext();
    codexAdapter.handleLine(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_0', type: 'agent_message', text: 'Finished.' },
      }),
      state.ctx,
    );
    expect(state.text).toEqual(['Finished.']);
    expect(state.final()).toBe('Finished.');
  });

  it('parses current item-based command and file-change activity', () => {
    const state = fakeContext();
    codexAdapter.handleLine(
      JSON.stringify({
        type: 'item.started',
        item: { id: 'item_1', type: 'command_execution', command: 'npm test' },
      }),
      state.ctx,
    );
    codexAdapter.handleLine(
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'file_change', changes: [{ path: 'src/foo.ts', kind: 'update' }] },
      }),
      state.ctx,
    );
    expect(state.status).toEqual(['[codex: exec npm test]', '[codex: edit src/foo.ts]']);
  });

  it('surfaces current turn.failed errors', () => {
    const state = fakeContext();
    codexAdapter.handleLine(
      JSON.stringify({ type: 'turn.failed', error: { message: 'request failed' } }),
      state.ctx,
    );
    expect(state.error()).toBe('request failed');
  });
});

describe('inferCliAgentName', () => {
  it('infers codex from a bare name', () => {
    expect(inferCliAgentName('codex')).toBe('codex');
  });

  it('infers codex from an absolute path with an extension', () => {
    expect(inferCliAgentName('C:\\tools\\codex.exe')).toBe('codex');
  });

  it('defaults to claude for anything else', () => {
    expect(inferCliAgentName('claude')).toBe('claude');
    expect(inferCliAgentName('/usr/local/bin/my-custom-agent')).toBe('claude');
  });
});
