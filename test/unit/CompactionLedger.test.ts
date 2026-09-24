import { describe, expect, it } from 'vitest';
import {
  classifyResult,
  collectCommandActions,
  collectRecordedActions,
  collectWriteActions,
  collectWrittenFiles,
  mergeRecordedActions,
  recordedActionsBlock,
  renderRecordedActionsBlock,
} from '../../src/sidebar/compactionLedger';
import { TOOL_INTERRUPTED_RESULT } from '../../src/sidebar/sessionPersistence';
import { formatExecCommandOutput } from '../../src/tools/execHelpers';
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
    expect(actions).toEqual([
      {
        kind: 'file',
        key: 'file:src/foo.ts',
        outcome: 'ok',
        line: '- write_file src/foo.ts',
      },
    ]);
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
    expect(actions[0]).toMatchObject({ outcome: 'ok', line: '- write_file a.ts' });
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
    expect(actions).toEqual([
      {
        kind: 'command',
        key: 'command:exec_command|.|args=["run","ci"]\u001fcommand=npm',
        outcome: 'ok',
        line: '- ran `npm run ci` → exit 0',
      },
    ]);
  });

  it('reads the exit code from exec_command’s structured result', () => {
    const ok = formatExecCommandOutput('npm', {
      stdout: 'Downloaded model.bin\nSaved to /models/model.bin',
      stderr: '',
      exitCode: 0,
    });
    const failed = formatExecCommandOutput('npm', { stdout: '', stderr: 'boom', exitCode: 2 });
    const killed = formatExecCommandOutput('npm', { stdout: '', stderr: '', exitCode: null });
    const actions = collectCommandActions([
      call('a', 'exec_command', { command: 'npm', args: ['ci'] }),
      result('a', ok),
      call('b', 'exec_command', { command: 'npm', args: ['test'] }),
      result('b', failed),
      call('c', 'query_powershell', { operation: 'list' }),
      result('c', killed),
    ]);
    expect(actions.map((action) => action.outcome)).toEqual(['ok', 'failed', 'unknown']);
    expect(actions[0]?.line).toBe(
      '- ran `npm ci` → exit 0; output evidence: Downloaded model.bin | Saved to /models/model.bin',
    );
    expect(actions[1]?.line).toBe('- ran `npm test` → exit 2 (FAILED)');
    expect(actions[2]?.line).toContain('did not complete (exit null)');
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
    // The omission must read as history dropped for space, not as an absence
    // of work: a resumed agent otherwise redoes what it cannot see.
    expect(block).toContain('7 older recorded entries omitted for space');
    expect(block).toContain('they happened; they are not listed here');
  });

  it('keeps recent successes when old failures could have filled every slot', () => {
    // The original filling order took non-successes first, in oldest-first
    // insertion order, so a run of old failures evicted every recent success
    // and the agent redid work it had just finished.
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 24; i++) {
      messages.push(
        call(`old${i}`, 'write_file', { path: `src/old${i}.ts` }),
        result(`old${i}`, 'Error: stale failure'),
      );
    }
    for (let i = 0; i < 10; i++) {
      messages.push(
        call(`new${i}`, 'write_file', { path: `src/new${i}.ts` }),
        result(`new${i}`, 'done'),
      );
    }

    const block = recordedActionsBlock(messages);
    expect(block).toContain('write_file src/new9.ts');
    expect(block).toContain('write_file src/new0.ts');
    // The latest failures still survive; they simply cannot take every slot.
    expect(block).toContain('src/old23.ts');
    expect(block).not.toContain('src/old0.ts');
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

  it('keeps distinct commands distinct, even when they name the same artifact', () => {
    // Keying on the first absolute path in the OUTPUT merged these two: the
    // removal superseded the download, and the ledger then claimed only that
    // the file had been removed. Output naming a path is evidence, not identity.
    const first = collectRecordedActions([
      call('old', 'exec_command', {
        command: 'download',
        args: ['N:\\AI\\models\\krea.safetensors'],
      }),
      result('old', 'Saved to N:\\AI\\models\\krea.safetensors\n[exit code: 0]'),
    ]);
    const later = collectRecordedActions([
      call('new', 'exec_command', {
        command: 'remove',
        args: ['N:\\AI\\models\\krea.safetensors'],
      }),
      result('new', 'Removed N:\\AI\\models\\krea.safetensors\n[exit code: 0]'),
    ]);

    const merged = mergeRecordedActions(first, later);
    const rendered = renderRecordedActionsBlock(merged.actions, merged.omitted);
    expect(merged.actions).toHaveLength(2);
    expect(rendered).toContain('Saved to N:\\AI\\models\\krea.safetensors');
    expect(rendered).toContain('Removed N:\\AI\\models\\krea.safetensors');
  });

  it('supersedes an earlier observation of the same command in the same directory', () => {
    const failed = collectRecordedActions([
      call('a', 'run_build', { script: 'ci', cwd: 'packages/api' }),
      result('a', '[exit code: 1]'),
    ]);
    const fixed = collectRecordedActions([
      call('b', 'run_build', { script: 'ci', cwd: 'packages/api' }),
      result('b', '[exit code: 0]'),
    ]);

    const merged = mergeRecordedActions(failed, fixed);
    expect(merged.actions).toHaveLength(1);
    expect(merged.actions[0]?.outcome).toBe('ok');
  });

  it('does not merge the same command run in different working directories', () => {
    // `npm run ci` in two packages of a monorepo were one entry, so a failure
    // in one silently replaced a success in the other.
    const api = collectRecordedActions([
      call('a', 'run_build', { script: 'ci', cwd: 'packages/api' }),
      result('a', '[exit code: 0]'),
    ]);
    const web = collectRecordedActions([
      call('b', 'run_build', { script: 'ci', cwd: 'packages/web' }),
      result('b', '[exit code: 1]'),
    ]);

    const merged = mergeRecordedActions(api, web);
    expect(merged.actions).toHaveLength(2);
    expect(merged.actions.filter((action) => action.outcome === 'ok')).toHaveLength(1);
  });

  it('carries the omission count forward so a second compaction still discloses it', () => {
    const many = collectRecordedActions(
      Array.from({ length: 40 }, (_, i) => [
        call(`f${i}`, 'write_file', { path: `src/f${i}.ts` }),
        result(`f${i}`, 'done'),
      ]).flat(),
    );
    const first = mergeRecordedActions(undefined, many);
    expect(first.omitted.file).toBeGreaterThan(0);

    // Second generation: recomputing from the already-capped list would report
    // zero, and the earlier omission would silently vanish.
    const second = mergeRecordedActions(first.actions, [], first.omitted);
    expect(second.omitted.file).toBe(first.omitted.file);
    expect(renderRecordedActionsBlock(second.actions, second.omitted)).toContain(
      'omitted for space',
    );
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
