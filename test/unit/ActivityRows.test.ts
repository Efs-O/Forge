import { describe, expect, it } from 'vitest';
import { toRows, type ActivityViewMode } from '../../webview-ui/src/activityRows';
import type { AppMessage } from '../../webview-ui/src/messageOps';

function row(id: string, role: AppMessage['role'], content: string, extra = {}): AppMessage {
  return { id, role, content, ...extra };
}

describe('activity row folding', () => {
  // CI-enforced full-mode contract from the plan's State × lifecycle ledger:
  // this golden pins the pre-extraction transcript folding for the disable mode.
  it('keeps the nine-call sequence in today’s exact row groups in full mode', () => {
    const messages = [
      row('r1', 'assistant', '', { reasoning: 'inspect' }),
      row('t1', 'tool', 'read_file'),
      row('d1', 'diff', 'a.ts'),
      row('r2', 'assistant', '', { reasoning: 'first edit' }),
      row('t2', 'tool', 'edit_file', { toolIsError: true }),
      row('r3', 'assistant', '', { reasoning: 'retry' }),
      row('t3', 'tool', 'edit_file'),
      row('d2', 'diff', 'a.ts'),
      row('t4', 'tool', 'format_file'),
      row('t5', 'tool', 'lint_file'),
      row('d3', 'diff', 'b.ts'),
      row('t6', 'tool', 'test_file'),
      row('t7', 'tool', 'search_code'),
      row('t8', 'tool', 'open_file'),
      row('t9', 'tool', 'git_status'),
      row('r4', 'assistant', '', { reasoning: 'wrap up one' }),
      row('r5', 'assistant', '', { reasoning: 'wrap up two' }),
    ];

    expect(toRows(messages, 'full').map((item) => [
      item.kind,
      item.kind === 'message'
        ? item.message.id
        : item.kind === 'diffGroup'
          ? item.diffs.map((message) => message.id)
          : item.kind === 'thinkingGroup'
            ? item.steps.map((message) => message.id)
            : item.tools.map((message) => message.id),
    ])).toEqual([
      ['thinkingGroup', ['r1']],
      ['toolGroup', ['t1']],
      ['diffGroup', ['d1']],
      ['thinkingGroup', ['r2']],
      ['toolGroup', ['t2']],
      ['thinkingGroup', ['r3']],
      ['toolGroup', ['t3']],
      ['diffGroup', ['d2']],
      ['toolGroup', ['t4', 't5']],
      ['diffGroup', ['d3']],
      ['toolGroup', ['t6', 't7', 't8', 't9']],
      ['thinkingGroup', ['r4', 'r5']],
    ]);
  });

  it('keeps an error and system row between tool runs as message boundaries', () => {
    const messages = [
      row('t1', 'tool', 'first'),
      row('e1', 'error', 'failed'),
      row('t2', 'tool', 'second'),
      row('s1', 'system', 'notice'),
      row('t3', 'tool', 'third'),
      row('a1', 'assistant', 'Checking the result.'),
      row('t4', 'tool', 'fourth'),
    ];

    expect(toRows(messages, 'full').map((item) =>
      item.kind === 'message' ? `${item.message.role}:${item.message.id}` : `${item.kind}:${item.kind === 'toolGroup' ? item.tools.map((m) => m.id).join(',') : ''}`,
    )).toEqual([
      'toolGroup:t1',
      'error:e1',
      'toolGroup:t2',
      'system:s1',
      'toolGroup:t3',
      'assistant:a1',
      'toolGroup:t4',
    ]);
  });

  it('folds several adjacent tool rows as one parallel round', () => {
    const messages = [row('a', 'tool', 'one'), row('b', 'tool', 'two'), row('c', 'tool', 'three')];
    expect(toRows(messages, 'full')).toEqual([{ kind: 'toolGroup', tools: messages }]);
  });

  it('retains content-bearing assistant messages as standalone rows', () => {
    const message = row('answer', 'assistant', 'The work is done.', { reasoning: 'private thought' });
    expect(toRows([message], 'full')).toEqual([{ kind: 'message', message, index: 0 }]);
  });

  it.todo('compact mode will fold calls into step rows');
  it.todo('grouped mode will fold adjacent steps into activity groups');

  it('accepts all current mode names in its public type contract', () => {
    const modes: ActivityViewMode[] = ['grouped', 'compact', 'full'];
    expect(modes.map((mode) => toRows([], mode))).toEqual([[], [], []]);
  });
});
