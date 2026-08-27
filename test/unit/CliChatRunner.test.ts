import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CheckpointStack } from '../../src/checkpoint/CheckpointStack';
import { buildCliChatTask, buildCliResumeTask, runCliChat } from '../../src/agents/CliChatRunner';
import type { CliAgentDriver } from '../../src/agents/CliAgentDriver';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('CliChatRunner', () => {
  it('includes prior conversation context and the latest request', () => {
    const prompt = buildCliChatTask([
      { role: 'user', content: 'First request' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Now implement it' },
    ]);
    expect(prompt).toContain('USER:\nFirst request');
    expect(prompt).toContain('ASSISTANT:\nFirst answer');
    expect(prompt).toContain('USER:\nNow implement it');
    expect(prompt).toContain('selected agent session policy');
  });

  it('sends only the latest user request when resuming a CLI session', () => {
    const prompt = buildCliResumeTask([
      { role: 'user', content: 'First request' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Continue with this' },
    ]);
    expect(prompt).toBe('Continue with this');
  });

  it('keeps the host-recorded plan on a CLI resume without restoring old requests', () => {
    const prompt = buildCliResumeTask(
      [
        { role: 'user', content: 'First request' },
        { role: 'assistant', content: 'First answer' },
        { role: 'user', content: 'Latest request' },
      ],
      '**Task plan (recorded by Forge, updated just now):**\n- [>] in progress: finish it',
    );

    expect(prompt).toContain('Task plan (recorded by Forge');
    expect(prompt).toContain('Latest request');
    expect(prompt).not.toContain('First request');
  });

  it('keeps one-shot Codex chat read-only, streams activity, and joins streamed and final text', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cli-chat-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'existing.txt'), 'before');
    fs.mkdirSync(path.join(root, '.forge'));
    fs.writeFileSync(path.join(root, '.forge', 'config.yaml'), 'live-config');
    const stack = new CheckpointStack();
    const checkpoint = stack.beginTurn('turn-1');
    const onText = vi.fn();
    const onStatus = vi.fn();
    const run = vi.fn(async (options: Parameters<CliAgentDriver['run']>[0]) => {
      options.onEvent?.({ kind: 'text', text: 'Working. ' });
      options.onEvent?.({ kind: 'status', text: '[codex: edit existing.txt]' });
      fs.writeFileSync(path.join(root, 'existing.txt'), 'after');
      fs.writeFileSync(path.join(root, 'created.txt'), 'new');
      fs.writeFileSync(path.join(root, '.forge', 'config.yaml'), 'not-checkpointed');
      return { status: 'completed' as const, finalText: 'Done.' };
    });

    const result = await runCliChat({
      prepared: { cliName: 'codex', executable: 'codex' },
      model: { name: 'codex', provider: 'cli', cli: 'codex' },
      messages: [{ role: 'user', content: 'Edit the file' }],
      workspaceRoot: root,
      checkpoint,
      signal: new AbortController().signal,
      onText,
      onStatus,
      driver: { run } as unknown as CliAgentDriver,
    });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ access: 'read', cwd: root }));
    expect(onStatus).toHaveBeenCalledWith('[codex: edit existing.txt]');
    expect(result.assistantText).toBe('Working.\n\nDone.');
    expect(onText).toHaveBeenLastCalledWith('\nDone.');

    stack.commitTurn(checkpoint);
    expect(stack.canUndo()).toBe(true);
    await stack.undo();
    expect(fs.readFileSync(path.join(root, 'existing.txt'), 'utf8')).toBe('before');
    expect(fs.existsSync(path.join(root, 'created.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(root, '.forge', 'config.yaml'), 'utf8')).toBe(
      'not-checkpointed',
    );
  });

  it('forwards session and model selection to the CLI driver', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cli-resume-'));
    roots.push(root);
    const stack = new CheckpointStack();
    const checkpoint = stack.beginTurn('turn-resume');
    const run = vi.fn(async () => ({
      status: 'completed' as const,
      finalText: 'Continued.',
      sessionId: 'session-1',
    }));

    await runCliChat({
      prepared: { cliName: 'claude', executable: 'claude' },
      model: {
        name: 'claude-code',
        provider: 'cli',
        cli: 'claude',
        cli_model: 'opus',
      },
      messages: [
        { role: 'user', content: 'Old request' },
        { role: 'assistant', content: 'Old answer' },
        { role: 'user', content: 'New request' },
      ],
      sessionId: 'session-1',
      workspaceRoot: root,
      checkpoint,
      signal: new AbortController().signal,
      onText: vi.fn(),
      onStatus: vi.fn(),
      driver: { run } as unknown as CliAgentDriver,
    });

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'New request', sessionId: 'session-1', model: 'opus' }),
    );
  });

  it('runs without scanning when external CLI rollback is explicitly disabled', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cli-no-rollback-'));
    roots.push(root);
    const target = path.join(root, 'large.txt');
    fs.writeFileSync(target, '12345');
    const stack = new CheckpointStack({
      limits: { maxBytes: 4, maxFiles: 100 },
      externalCliRollbackEnabled: false,
    });
    const checkpoint = stack.beginTurn('turn-no-rollback');
    const onStatus = vi.fn();
    const run = vi.fn(async () => {
      fs.writeFileSync(target, 'changed');
      return { status: 'completed' as const, finalText: 'Done.' };
    });

    await runCliChat({
      prepared: { cliName: 'claude', executable: 'claude' },
      model: { name: 'claude-code', provider: 'cli', cli: 'claude' },
      messages: [{ role: 'user', content: 'hello' }],
      workspaceRoot: root,
      checkpoint,
      signal: new AbortController().signal,
      onText: vi.fn(),
      onStatus,
      driver: { run } as unknown as CliAgentDriver,
    });

    stack.commitTurn(checkpoint);
    expect(run).toHaveBeenCalledOnce();
    expect(onStatus).toHaveBeenCalledWith(expect.stringMatching(/rollback protection is disabled/i));
    expect(stack.canUndo()).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('changed');
  });
});
