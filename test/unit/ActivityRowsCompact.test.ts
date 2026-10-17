import { describe, expect, it } from 'vitest';
import { displayDetail, rowKey, toCompactRows, type Row } from '../../webview-ui/src/activityRows';
import { mergeSyncedMessages, type AppMessage, type PersistedRow } from '../../webview-ui/src/messageOps';

function msg(
  id: string,
  role: AppMessage['role'],
  content = '',
  fields: Partial<AppMessage> = {},
): AppMessage {
  return { id, role, content, ...fields };
}

function tool(id: string, name: string, target = 'src/a.ts', fields: Partial<AppMessage> = {}): AppMessage {
  return msg(id, 'tool', `${name} → ${target}`, { toolName: name, toolTarget: target, ...fields });
}

function pause(id: string): AppMessage {
  return msg(id, 'assistant', '', { reasoning: `thought ${id}` });
}

function steps(rows: Row[]) {
  return rows.filter((row) => row.kind === 'step');
}

describe('compact activity rows', () => {
  it('keeps thoughts at transcript level before tool steps', () => {
    const thoughts = [msg('r1', 'assistant', '', { reasoning: 'one' }), msg('r2', 'assistant', '', { reasoning: 'two' })];
    const rows = toCompactRows([...thoughts, tool('t1', 'read_file'), ...thoughts.map((m) => ({ ...m, id: `tail-${m.id}` }))]);
    expect(rows.map((row) => row.kind)).toEqual(['thinkingGroup', 'step', 'thinkingGroup']);
    expect(rows[0]).toMatchObject({ kind: 'thinkingGroup', steps: thoughts });
    expect(rows[1]).toMatchObject({ kind: 'step', step: { attempts: [{ tools: [expect.objectContaining({ id: 't1' })] }] } });
    expect(rows[2]).toMatchObject({ kind: 'thinkingGroup', steps: [{ id: 'tail-r1' }, { id: 'tail-r2' }] });
  });

  it('attaches matching diffs by call id, including diffs after all parallel calls', () => {
    const a = tool('a', 'edit_file', 'a.ts', { toolCallId: 'call-a' });
    const b = tool('b', 'edit_file', 'b.ts', { toolCallId: 'call-b' });
    const da = msg('da', 'diff', 'a.ts', { toolCallId: 'call-a' });
    const db = msg('db', 'diff', 'b.ts', { toolCallId: 'call-b' });
    const rows = toCompactRows([a, b, da, db]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'step', step: { attempts: [{ tools: [a, b] }], diffs: [da, db] } });
  });

  it('leaves a nonmatching diff and a diff without a call id standalone', () => {
    const rows = toCompactRows([
      tool('t', 'edit_file', 'a.ts', { toolCallId: 'call-a' }),
      msg('wrong', 'diff', 'wrong.ts', { toolCallId: 'call-z' }),
      msg('legacy', 'diff', 'legacy.ts'),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(['step', 'diffGroup']);
    expect(rows[1]).toMatchObject({ kind: 'diffGroup', diffs: [{ id: 'wrong' }, { id: 'legacy' }] });
  });

  it('keeps reasoning before a retry as a top-level block', () => {
    const failed = tool('failed', 'edit_file', 'a.ts', { toolCallId: 'one', toolIsError: true });
    const retry = tool('retry', 'edit_file', 'a.ts', { toolCallId: 'two' });
    const thought = pause('retry-thought');
    const rows = toCompactRows([failed, thought, retry]);
    expect(rows.map((row) => row.kind)).toEqual(['step', 'thinkingGroup', 'step']);
    expect(steps(rows)).toHaveLength(2);
    expect(rows[1]).toMatchObject({ kind: 'thinkingGroup', steps: [thought] });
  });

  it('keeps plain repeats separated by reasoning in transcript order', () => {
    const one = tool('one', 'render_html_to_image', 'page.html');
    const two = tool('two', 'render_html_to_image', 'page.html');
    expect(toCompactRows([one, pause('between'), two]).map((row) => row.kind)).toEqual([
      'step', 'thinkingGroup', 'step',
    ]);
  });

  it('keeps two diff-producing edits, different targets, and targetless calls separate', () => {
    const edit1 = tool('e1', 'edit_file', 'a.ts', { toolCallId: 'a' });
    const diff1 = msg('d1', 'diff', 'a.ts', { toolCallId: 'a' });
    const edit2 = tool('e2', 'edit_file', 'a.ts', { toolCallId: 'b' });
    const diff2 = msg('d2', 'diff', 'a.ts', { toolCallId: 'b' });
    const different = tool('e3', 'edit_file', 'b.ts');
    const noTarget1 = tool('n1', 'search_code', '');
    const noTarget2 = tool('n2', 'search_code', '');
    delete noTarget1.toolTarget;
    delete noTarget2.toolTarget;
    expect(steps(toCompactRows([edit1, diff1, edit2, diff2]))).toHaveLength(2);
    expect(steps(toCompactRows([different, pause('different-target'), tool('e4', 'edit_file', 'c.ts')]))).toHaveLength(2);
    expect(steps(toCompactRows([noTarget1, pause('missing-target'), noTarget2]))).toHaveLength(2);
  });

  it('never merges parallel rounds', () => {
    const parallel = [
      tool('a', 'search_code', 'same'),
      tool('b', 'search_code', 'same'),
    ];
    const next = tool('c', 'search_code', 'same');
    expect(steps(toCompactRows([...parallel, pause('next-round'), next]))).toHaveLength(2);
  });

  it.each(['user', 'system', 'error', 'assistant'] as const)(
    'ends a step at a %s message boundary',
    (role) => {
      const boundary = msg('boundary', role, 'narration');
      expect(toCompactRows([tool('a', 'read_file'), boundary, tool('b', 'read_file')]).map((row) => row.kind))
        .toEqual(['step', 'message', 'step']);
    },
  );

  it('strips shell cd prefixes only at the start', () => {
    expect(displayDetail('cd /workspace/project && npm test')).toBe('npm test');
    expect(displayDetail('cd /workspace/project; npm test')).toBe('npm test');
    expect(displayDetail('echo "cd /tmp && no"')).toBe('echo "cd /tmp && no"');
    expect(displayDetail('cd "n:/vs code apps/hb-runs/forge" && grep -n x f')).toBe('grep -n x f');
    expect(displayDetail("cd 'a b' && cd sub && sed -n 1p f")).toBe('sed -n 1p f');
  });

  it('keeps thinking blocks between the nine calls in transcript order', () => {
    const sequence = [
      tool('1', 'read_file', 'a.ts'),
      pause('r1'),
      tool('2', 'edit_file', 'a.ts', { toolCallId: 'retry-1', toolIsError: true }),
      pause('r2'),
      tool('3', 'edit_file', 'a.ts', { toolCallId: 'retry-2' }),
      pause('r3'),
      tool('4', 'render_html_to_image', 'page.html'),
      pause('r4'),
      tool('5', 'render_html_to_image', 'page.html'),
      pause('r5'),
      tool('6', 'search_code', 'one'),
      pause('r6'),
      tool('7', 'search_code', 'two'),
      pause('r7'),
      tool('8', 'search_code', 'three'),
      pause('r8'),
      tool('9', 'search_code', 'four'),
      msg('tail', 'assistant', '', { reasoning: 'final thought' }),
    ];
    const rows = toCompactRows(sequence);
    expect(steps(rows)).toHaveLength(9);
    expect(rows.map((row) => row.kind)).toEqual([
      'step', 'thinkingGroup', 'step', 'thinkingGroup', 'step', 'thinkingGroup',
      'step', 'thinkingGroup', 'step', 'thinkingGroup', 'step', 'thinkingGroup',
      'step', 'thinkingGroup', 'step', 'thinkingGroup', 'step', 'thinkingGroup',
    ]);
    expect(rows.at(-1)?.kind).toBe('thinkingGroup');
  });

  it('keeps the first step key stable when a thought-led retry becomes a new step', () => {
    const first = tool('first', 'edit_file', 'a.ts', { toolIsError: true });
    const before = steps(toCompactRows([first]))[0]!;
    const after = steps(toCompactRows([first, pause('retry-thought'), tool('retry', 'edit_file', 'a.ts')]))[0]!;
    expect(rowKey(before)).toBe('first');
    expect(rowKey(after)).toBe('first');
  });

  it('keeps a step key stable when a same-target retry appends without new reasoning', () => {
    const first = tool('first', 'edit_file', 'a.ts', { toolIsError: true });
    const retry = tool('retry', 'edit_file', 'a.ts');
    const initialThought = pause('initial-thought');
    const before = steps(toCompactRows([initialThought, first]))[0]!;
    const after = steps(toCompactRows([initialThought, first, retry]))[0]!;
    expect(rowKey(before)).toBe('first');
    expect(rowKey(after)).toBe(rowKey(before));
  });

  it('keeps every step key through a live-to-synced reconcile', () => {
    const local = [
      msg('reason', 'assistant', '', { reasoning: 'inspect', reasoningMs: 1200 }),
      tool('tool', 'edit_file', 'a.ts', {
        toolCallId: 'call-a', toolDetail: 'edit_file a.ts', toolResult: 'done', toolResultTotal: 4,
      }),
      msg('diff', 'diff', 'src/a.ts', { toolCallId: 'call-a', diffHunks: null }),
      pause('next-reason'),
      tool('next', 'read_file', 'b.ts', { toolCallId: 'call-b', toolResult: 'read', toolResultTotal: 4 }),
    ];
    const persisted: PersistedRow[] = [
      { role: 'assistant', content: '', reasoning: 'inspect', reasoningMs: 1200 },
      {
        role: 'tool', content: 'edit_file → a.ts', toolName: 'edit_file', toolCallId: 'call-a',
        toolTarget: 'a.ts', toolDetail: 'edit_file a.ts', toolResult: 'done', toolResultTotal: 4,
      },
      {
        role: 'diff', content: 'src/a.ts', toolCallId: 'call-a', diffHunks: null,
        diffIsNew: false, diffIsDeleted: false,
      },
      { role: 'assistant', content: '', reasoning: 'thought next-reason' },
      {
        role: 'tool', content: 'read_file → b.ts', toolName: 'read_file', toolCallId: 'call-b',
        toolTarget: 'b.ts', toolResult: 'read', toolResultTotal: 4,
      },
    ];
    const before = steps(toCompactRows(local)).map(rowKey);
    const after = steps(toCompactRows(mergeSyncedMessages(local, persisted))).map(rowKey);
    expect(after).toEqual(before);
  });

  it('keeps a live thought-plus-answer row id when the host stores it as two rows', () => {
    const local = [
      msg('user', 'user', 'go'),
      msg('both', 'assistant', 'Let me look.', { reasoning: 'think', reasoningMs: 900 }),
      tool('read', 'read_file', 'a.ts', { toolCallId: 'call-a', toolResult: 'x', toolResultTotal: 1 }),
    ];
    const persisted: PersistedRow[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', reasoning: 'think', reasoningMs: 900 },
      { role: 'assistant', content: 'Let me look.' },
      {
        role: 'tool', content: 'read_file → a.ts', toolName: 'read_file', toolCallId: 'call-a',
        toolTarget: 'a.ts', toolResult: 'x', toolResultTotal: 1,
      },
    ];
    const merged = mergeSyncedMessages(local, persisted);
    expect(merged.map((message) => message.id)).toEqual(['user', 'both', 'both-answer', 'read']);
    expect(merged[1]).toMatchObject({ content: '', reasoning: 'think', reasoningMs: 900 });
    expect(merged[2]).toMatchObject({ content: 'Let me look.' });
    expect(merged[2]!.reasoning).toBeUndefined();
  });
});
