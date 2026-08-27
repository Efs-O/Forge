import { describe, expect, it } from 'vitest';
import {
  classifyResult,
  collectCommandActions,
  collectWriteActions,
  collectWrittenFiles,
  recordedActionsBlock,
} from '../../src/sidebar/compactionLedger';
import { TOOL_INTERRUPTED_RESULT } from '../../src/sidebar/sessionPersistence';
import type { ChatMessage } from '../../src/llm/types';

function call(id: string, name: string, args: Record<string, unknown>): ChatMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  };
}

function result(id: string, content: string): ChatMessage {
  return { role: 'tool', content, tool_call_id: id };
}

describe('classifyResult', () => {
  it('treats a normal handler result as success', () => {
    expect(classifyResult('Wrote 42 lines.')).toBe('ok');
  });

  it('treats every host-owned failure and refusal as failed', () => {
    // Only the first of these carries the `Error:` prefix the original
    // implementation checked for; the rest are why that check was not enough.
    expect(classifyResult('Error: ENOENT')).toBe('failed');
    expect(classifyResult('User declined: write_file')).toBe('failed');
    expect(classifyResult('Budget exhausted: read_file was limited to 5 calls this turn')).toBe(
      'failed',
    );
    expect(classifyResult('Tool view_image is not available for this model.')).toBe('failed');
  });

  it('treats a missing, empty, or interrupted result as unknown', () => {
    expect(classifyResult(undefined)).toBe('unknown');
    expect(classifyResult('   ')).toBe('unknown');
    expect(classifyResult(TOOL_INTERRUPTED_RESULT)).toBe('unknown');
  });
});

describe('collectWriteActions', () => {
  it('records a successful write as done', () => {
    const actions = collectWriteActions([
      call('a', 'write_file', { path: 'src/foo.ts' }),
      result('a', 'Wrote src/foo.ts'),
    ]);
    expect(actions).toEqual([{ outcome: 'ok', line: '- write_file src/foo.ts' }]);
  });

  it('never reports a failed write as a completed one', () => {
    const actions = collectWriteActions([
      call('a', 'edit_file', { filepath: 'src/foo.ts' }),
      result('a', 'Error: no match for the search text'),
    ]);
    expect(actions[0]?.outcome).toBe('failed');
    expect(actions[0]?.line).toContain('FAILED edit_file src/foo.ts');
    expect(actions[0]?.line).toContain('no match for the search text');
    expect(actions[0]?.line).not.toContain('- edit_file src/foo.ts');
  });

  it('never reports a declined write as a completed one', () => {
    const actions = collectWriteActions([
      call('a', 'delete_file', { path: 'src/foo.ts' }),
      result('a', 'User declined: delete_file'),
    ]);
    expect(actions[0]?.outcome).toBe('failed');
  });

  it('marks a write with no paired result as attempted, not done', () => {
    // The mid-turn compaction case: the call is in the snapshot, its result is
    // not yet.
    const actions = collectWriteActions([call('a', 'write_file', { path: 'src/foo.ts' })]);
    expect(actions[0]?.outcome).toBe('unknown');
    expect(actions[0]?.line).toContain('ATTEMPTED write_file src/foo.ts');
  });

  it('marks a write interrupted by a reload as unknown', () => {
    const actions = collectWriteActions([
      call('a', 'write_file', { path: 'src/foo.ts' }),
      result('a', TOOL_INTERRUPTED_RESULT),
    ]);
    expect(actions[0]?.outcome).toBe('unknown');
  });

  it('pairs by tool_call_id, not by position', () => {
    const actions = collectWriteActions([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.ts"}' } },
          { id: 'b', type: 'function', function: { name: 'write_file', arguments: '{"path":"b.ts"}' } },
        ],
      },
      result('b', 'Error: disk full'),
      result('a', 'Wrote a.ts'),
    ]);
    expect(actions[0]).toEqual({ outcome: 'ok', line: '- write_file a.ts' });
    expect(actions[1]?.outcome).toBe('failed');
  });

  it('skips a call whose arguments are not parseable JSON', () => {
    const broken: ChatMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'a', type: 'function', function: { name: 'write_file', arguments: '{"pa' } }],
    };
    expect(collectWriteActions([broken])).toEqual([]);
  });
});

describe('collectCommandActions', () => {
  it('records an exit code of zero', () => {
    const actions = collectCommandActions([
      call('a', 'exec_command', { command: 'npm', args: ['run', 'ci'] }),
      result('a', 'all good\n[exit code: 0]'),
    ]);
    expect(actions).toEqual([{ outcome: 'ok', line: '- ran `npm run ci` → exit 0' }]);
  });

  it('pins concrete download evidence from a successful command', () => {
    const actions = collectCommandActions([
      call('krea', 'exec_command', {
        command: 'huggingface-cli',
        args: ['download', 'Comfy-Org/Krea-2', 'krea2_turbo_fp8_scaled.safetensors'],
      }),
      result(
        'krea',
        'Downloaded krea2_turbo_fp8_scaled.safetensors\nSaved to N:\\AI\\ComfyUI\\models\\diffusion_models\\krea2_turbo_fp8_scaled.safetensors\n[exit code: 0]',
      ),
    ]);

    expect(actions[0]?.outcome).toBe('ok');
    expect(actions[0]?.line).toContain('output evidence: Downloaded krea2_turbo');
    expect(actions[0]?.line).toContain('Saved to N:\\AI\\ComfyUI');
    expect(actions[0]?.durableEvidence).toBe(true);
  });

  it('makes a non-zero exit as loud as a success', () => {
    const actions = collectCommandActions([
      call('a', 'run_tests', {}),
      result('a', '3 failed\n[exit code: 1]'),
    ]);
    expect(actions[0]?.outcome).toBe('failed');
    expect(actions[0]?.line).toBe('- ran `run_tests` → exit 1 (FAILED)');
  });

  it('records a killed command as not completed', () => {
    const actions = collectCommandActions([
      call('a', 'run_build', { script: 'build' }),
      result('a', 'timed out\n[exit code: null]'),
    ]);
    expect(actions[0]?.outcome).toBe('unknown');
    expect(actions[0]?.line).toBe('- ran `npm run build` → did not complete (exit null)');
  });

  it('never infers success from a result carrying no exit code', () => {
    const actions = collectCommandActions([
      call('a', 'exec_command', { command: 'npm' }),
      result('a', 'looks fine to me'),
    ]);
    expect(actions[0]?.outcome).toBe('unknown');
    expect(actions[0]?.line).toContain('outcome unknown (no exit code)');
  });

  it('always treats run_terminal as unknown, because it never runs unattended', () => {
    const actions = collectCommandActions([
      call('a', 'run_terminal', { command: 'npm test' }),
      result('a', 'Pasted into the Forge terminal.'),
    ]);
    expect(actions[0]?.outcome).toBe('unknown');
    expect(actions[0]?.line).toContain('never runs unattended');
  });

  it('reads the last exit code when a result contains several', () => {
    const actions = collectCommandActions([
      call('a', 'exec_command', { command: 'npm' }),
      result('a', 'earlier log said [exit code: 0]\nreal result\n[exit code: 2]'),
    ]);
    expect(actions[0]?.line).toContain('exit 2 (FAILED)');
  });
});

describe('recordedActionsBlock', () => {
  it('is empty when nothing recordable happened', () => {
    expect(recordedActionsBlock([{ role: 'user', content: 'hi' }])).toBe('');
  });

  it('labels both sections as host-recorded', () => {
    const block = recordedActionsBlock([
      call('a', 'write_file', { path: 'src/foo.ts' }),
      result('a', 'ok'),
      call('b', 'exec_command', { command: 'npm', args: ['run', 'ci'] }),
      result('b', '[exit code: 0]'),
    ]);
    expect(block).toContain('**File changes (recorded by Forge, not written by the model):**');
    expect(block).toContain('**Commands run (recorded by Forge, not written by the model):**');
  });

  it('never lets the cap turn a truncated ledger into an all-success one', () => {
    // 30 successes then one failure: a naive head-slice at 24 would drop the
    // only entry that matters and assert that everything worked.
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(call(`ok${i}`, 'write_file', { path: `src/f${i}.ts` }), result(`ok${i}`, 'done'));
    }
    messages.push(call('bad', 'write_file', { path: 'src/bad.ts' }), result('bad', 'Error: nope'));

    const block = recordedActionsBlock(messages);
    expect(block).toContain('FAILED write_file src/bad.ts');
    expect(block).toContain('…and 7 more');
  });

  it('keeps successful artifact evidence when ordinary successes exceed the cap', () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(call(`ok${i}`, 'exec_command', { command: `echo ${i}` }), result(`ok${i}`, '[exit code: 0]'));
    }
    messages.push(
      call('krea', 'exec_command', { command: 'download krea2' }),
      result('krea', 'Downloaded krea2_turbo_fp8_scaled.safetensors\n[exit code: 0]'),
    );

    expect(recordedActionsBlock(messages)).toContain('Downloaded krea2_turbo_fp8_scaled.safetensors');
  });
});

describe('collectWrittenFiles', () => {
  it('still reports every path a write tool named, regardless of outcome', () => {
    const files = collectWrittenFiles([
      call('a', 'edit_file', { filepath: 'src\\win.ts' }),
      call('b', 'move_file', { source: 'a.ts', destination: 'b.ts' }),
    ]);
    expect(files).toEqual(['src/win.ts', 'a.ts', 'b.ts']);
  });
});
