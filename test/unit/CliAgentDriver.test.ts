import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { CliAgentDriver } from '../../src/agents/CliAgentDriver';
import type { CliAgentEvent } from '../../src/agents/types';

const claudeFixture = path.resolve(__dirname, '../fixtures/fake-claude-cli.mjs');
const codexFixture = path.resolve(__dirname, '../fixtures/fake-codex-cli.mjs');

describe('CliAgentDriver', () => {
  it('parses claude stream-json: text deltas, tool-use status, and the final result', async () => {
    const events: CliAgentEvent[] = [];
    const result = await new CliAgentDriver().run({
      cliName: 'claude',
      executable: process.execPath,
      argsPrefix: [claudeFixture],
      task: 'do the thing',
      cwd: process.cwd(),
      onEvent: (event) => events.push(event),
    });
    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('Done: updated src/foo.ts');
    expect(events).toContainEqual({ kind: 'text', text: 'Looking at the repo. ' });
    expect(events).toContainEqual({ kind: 'status', text: '[claude: Edit src/foo.ts]' });
  });

  it('parses codex JSONL: text deltas, exec/patch status, and task_complete', async () => {
    const events: CliAgentEvent[] = [];
    const result = await new CliAgentDriver().run({
      cliName: 'codex',
      executable: process.execPath,
      argsPrefix: [codexFixture],
      task: 'do the thing',
      cwd: process.cwd(),
      onEvent: (event) => events.push(event),
    });
    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('Done: updated src/foo.ts');
    expect(events).toContainEqual({ kind: 'text', text: 'Looking at the repo. ' });
    expect(events).toContainEqual({ kind: 'status', text: '[codex: exec ls src]' });
    expect(events).toContainEqual({ kind: 'status', text: '[codex: edit src/foo.ts]' });
  });

  it('surfaces a non-zero exit as a failed result with exit code + stderr tail', async () => {
    const result = await new CliAgentDriver().run({
      cliName: 'claude',
      executable: process.execPath,
      argsPrefix: [claudeFixture],
      task: 'TRIGGER_FAIL',
      cwd: process.cwd(),
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('exited with code 1');
    expect(result.error).toContain('boom, something broke');
  });

  it('surfaces an is_error result message as failed without needing a non-zero exit', async () => {
    const result = await new CliAgentDriver().run({
      cliName: 'claude',
      executable: process.execPath,
      argsPrefix: [claudeFixture],
      task: 'TRIGGER_ERROR_RESULT',
      cwd: process.cwd(),
    });
    expect(result.status).toBe('failed');
    expect(result.error).toBe('refused: unsafe request');
  });

  it('surfaces a codex error event as failed', async () => {
    const result = await new CliAgentDriver().run({
      cliName: 'codex',
      executable: process.execPath,
      argsPrefix: [codexFixture],
      task: 'TRIGGER_ERROR_RESULT',
      cwd: process.cwd(),
    });
    expect(result.status).toBe('failed');
    expect(result.error).toBe('sandbox denied the requested command');
  });

  it('kills the child and returns cancelled on abort', async () => {
    const controller = new AbortController();
    const pending = new CliAgentDriver().run({
      cliName: 'claude',
      executable: process.execPath,
      argsPrefix: [claudeFixture],
      task: 'TRIGGER_SLOW',
      cwd: process.cwd(),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    expect(result.status).toBe('cancelled');
  }, 10_000);

  it('kills the child and returns timed_out when it exceeds timeoutMs', async () => {
    const result = await new CliAgentDriver().run({
      cliName: 'claude',
      executable: process.execPath,
      argsPrefix: [claudeFixture],
      task: 'TRIGGER_SLOW',
      cwd: process.cwd(),
      timeoutMs: 200,
    });
    expect(result.status).toBe('timed_out');
    expect(result.error).toContain('exceeded 200ms timeout');
  }, 10_000);
});
