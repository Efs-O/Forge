import { describe, expect, it } from 'vitest';
import { rowKey, type ActivityGroupItem, type ActivityStep, type Row, type StepAttempt } from '../../webview-ui/src/activityRows';
import type { AppMessage } from '../../webview-ui/src/messageOps';
import {
  groupActivity,
  recoveredFailures,
  summarizeGroup,
  visibleGroupItems,
} from '../../webview-ui/src/activityGroups';

const summarize = (items: ActivityGroupItem[]) => summarizeGroup(items);

/** Tool rounds as attempts with no reasoning before them. */
const attempts = (...rounds: AppMessage[][]): StepAttempt[] => rounds.map((tools) => ({ tools }));

function message(id: string, role: AppMessage['role'], content = '', extra: Partial<AppMessage> = {}): AppMessage {
  return { id, role, content, ...extra };
}

function step(id: string, rounds: AppMessage[][] = [[message(`${id}-tool`, 'tool', 'call', {
  toolName: 'edit_file', toolResultTotal: 1,
})]], overrides: Partial<ActivityStep> = {}): Row {
  return { kind: 'step', step: { attempts: attempts(...rounds), diffs: [], ...overrides } };
}

function groupOf(...rows: Row[]): Row {
  const [group] = groupActivity(rows);
  return group!;
}

describe('groupActivity', () => {
  it.each(['message', 'diffGroup', 'toolGroup'] as const)('treats %s as a group boundary', (kind) => {
    const first = step('first');
    const second = step('second');
    const boundary: Row = kind === 'message'
      ? { kind, message: message('boundary', 'assistant', 'narration'), index: 1 }
      : kind === 'diffGroup'
        ? { kind, diffs: [message('boundary', 'diff', 'a.ts')] }
        : { kind, tools: [message('boundary', 'tool', 'call')] };

    expect(groupActivity([first, second, boundary, step('third'), step('fourth')]).map((row) => row.kind))
      .toEqual(['activityGroup', kind, 'activityGroup']);
  });

  it('keeps thoughts at top level around a collapsed tool group', () => {
    const before: Row = { kind: 'thinkingGroup', steps: [message('thought', 'assistant', '', { reasoning: 'thinking' })] };
    const only = step('only');
    const after: Row = { kind: 'thinkingGroup', steps: [message('tail', 'assistant', '', { reasoning: 'tail' })] };
    expect(groupActivity([before, only, after])).toEqual([
      before,
      { kind: 'activityGroup', items: [{ kind: 'step', step: only.step }] },
      after,
    ]);
  });

  it('passes a thinking-only run through unchanged', () => {
    const rows: Row[] = [
      { kind: 'thinkingGroup', steps: [message('a', 'assistant', '', { reasoning: 'a' })] },
      { kind: 'thinkingGroup', steps: [message('b', 'assistant', '', { reasoning: 'b' })] },
    ];
    expect(groupActivity(rows)).toEqual(rows);
  });

  it('splits tool groups around top-level thinking rows', () => {
    const first = step('first');
    const thought: Row = { kind: 'thinkingGroup', steps: [message('thought', 'assistant', '', { reasoning: 'ponder' })] };
    const second = step('second');
    expect(groupActivity([first, thought, second]).map((row) => row.kind)).toEqual([
      'activityGroup', 'thinkingGroup', 'activityGroup',
    ]);
  });

  it('keeps the group key anchored to the first message as a step is appended', () => {
    const firstStep = { kind: 'step' as const, step: { attempts: attempts([message('first', 'tool', 'call')]), diffs: [] } };
    const appended = { kind: 'step' as const, step: { attempts: attempts([message('later', 'tool', 'call')]), diffs: [] } };
    const beforeAppend = groupOf(firstStep);
    const afterAppend = groupOf(firstStep, appended);
    expect(rowKey(beforeAppend)).toBe('first');
    expect(rowKey(afterAppend)).toBe(rowKey(beforeAppend));
  });
});

describe('summarizeGroup', () => {
  it('counts every tool in parallel rounds and every attempt', () => {
    const items: ActivityGroupItem[] = [{
      kind: 'step',
      step: {
        attempts: attempts(
          [message('a', 'tool', 'a'), message('b', 'tool', 'b')],
          [message('c', 'tool', 'c')],
        ),
        diffs: [],
      },
    }];
    expect(summarize(items).toolCalls).toBe(3);
  });

  it('summarizes one-file and several-file edits using diffStats', () => {
    const hunks = [{ lines: [
      { kind: 'added' as const, text: 'new' },
      { kind: 'added' as const, text: 'also new' },
      { kind: 'removed' as const, text: 'old' },
    ] }];
    const single = summarize([{
      kind: 'step',
      step: { attempts: attempts([message('tool', 'tool', 'edit')]), diffs: [
        message('d1', 'diff', 'src/pelican-joust.html', { diffHunks: hunks }),
        message('d2', 'diff', 'src/pelican-joust.html', { diffHunks: null }),
      ] },
    }]);
    expect(single).toMatchObject({ editCount: 2, fileCount: 1, fileLabel: 'to pelican-joust.html', added: 2, removed: 1 });

    const multiple = summarize([{
      kind: 'step',
      step: { attempts: [], diffs: [
        message('d1', 'diff', 'src/a.ts', { diffHunks: null }),
        message('d2', 'diff', 'src/b.ts', { diffHunks: null }),
      ] },
    }]);
    expect(multiple).toMatchObject({ editCount: 2, fileCount: 2, fileLabel: 'in 2 files', added: 0, removed: 0 });
  });

  it('counts a file the group created at its final size, not the sum of its writes', () => {
    const lines = (kind: 'added' | 'removed', n: number) =>
      Array.from({ length: n }, (_, i) => ({ kind, text: `${kind} ${i}` }));
    const summary = summarize([{
      kind: 'step',
      step: { attempts: attempts([message('tool', 'tool', 'write')]), diffs: [
        message('w', 'diff', '.forge/tmp/invaders.html', {
          diffIsNew: true, diffHunks: [{ lines: lines('added', 494) }],
        }),
        message('e', 'diff', '.forge/tmp/invaders.html', {
          diffHunks: [{ lines: [...lines('removed', 3), ...lines('added', 2)] }],
        }),
      ] },
    }]);
    expect(summary).toMatchObject({ editCount: 2, added: 493, removed: 0 });
  });

  it('distinguishes recovered retries from unrecovered failures', () => {
    const recovered = {
      kind: 'step' as const,
      step: {
        attempts: attempts(
          [message('failed', 'tool', 'edit', { toolIsError: true, toolResultTotal: 5 })],
          [message('retried', 'tool', 'edit', { toolResultTotal: 1 })],
        ),
        diffs: [],
      },
    };
    const failed = {
      kind: 'step' as const,
      step: { attempts: attempts([message('failed-final', 'tool', 'edit', { toolIsError: true })]), diffs: [] },
    };
    expect(summarize([recovered, failed])).toMatchObject({ retries: 1, failed: 1 });
  });

});

describe('recoveredFailures', () => {
  const failed = (id: string, target: string): ActivityGroupItem => ({
    kind: 'step',
    step: {
      attempts: attempts([
        message(id, 'tool', 'edit_file', {
          toolName: 'edit_file',
          toolTarget: target,
          toolIsError: true,
        }),
      ]),
      diffs: [],
    },
  });
  const succeeded = (id: string, target: string): ActivityGroupItem => ({
    kind: 'step',
    step: {
      attempts: attempts([
        message(id, 'tool', 'edit_file', {
          toolName: 'edit_file',
          toolTarget: target,
          toolResultTotal: 1,
        }),
      ]),
      diffs: [],
    },
  });

  it('marks a failed step recovered after a later same-target success', () => {
    const items = [failed('failed-a', 'src/a.ts'), succeeded('success-a', 'src/a.ts')];
    expect(recoveredFailures(items)).toEqual(new Set(['failed-a']));
  });

  it('leaves an unrecovered failed step out of the recovered set', () => {
    expect(recoveredFailures([failed('failed-a', 'src/a.ts')])).toEqual(new Set());
  });

  it('does not recover a failure with a success on a different target', () => {
    expect(recoveredFailures([
      failed('failed-a', 'src/a.ts'),
      succeeded('success-b', 'src/b.ts'),
    ])).toEqual(new Set());
  });
});

describe('visibleGroupItems', () => {
  const longGroup = (): ActivityGroupItem[] =>
    Array.from({ length: 40 }, (_, index) => ({
      kind: 'step' as const,
      step: {
        attempts: attempts([
          message(`call-${index}`, 'tool', 'call', {
            toolName: 'read_file',
            toolTarget: `src/${index}.ts`,
            toolResultTotal: index === 20 ? undefined : 1,
            ...(index === 20 ? { toolIsError: true } : {}),
          }),
        ]),
        diffs: [],
      },
    }));

  it('keeps the last six calls and pins an unrecovered failure between two gaps', () => {
    const items = longGroup();
    const visible = visibleGroupItems(items, recoveredFailures(items), new Set());
    expect(visible.filter((item) => item.kind === 'step').map((item) =>
      item.kind === 'step' ? item.step.attempts[0]!.tools[0]!.id : '',
    )).toEqual(['call-20', 'call-34', 'call-35', 'call-36', 'call-37', 'call-38', 'call-39']);
    expect(visible.filter((item) => item.kind === 'gap')).toEqual([
      { kind: 'gap', firstStepId: 'call-0', calls: 20, leading: true },
      { kind: 'gap', firstStepId: 'call-21', calls: 13, leading: false },
    ]);
  });

  it('reveals only the selected gap and leaves groups of ten calls whole', () => {
    const items = longGroup();
    const [firstGap] = visibleGroupItems(items, recoveredFailures(items), new Set())
      .filter((item) => item.kind === 'gap');
    if (!firstGap || firstGap.kind !== 'gap') throw new Error('expected leading gap');
    const revealed = visibleGroupItems(items, recoveredFailures(items), new Set([firstGap.firstStepId]));
    expect(revealed.filter((item) => item.kind === 'step')).toHaveLength(27);
    expect(revealed.filter((item) => item.kind === 'gap')).toEqual([
      { kind: 'gap', firstStepId: 'call-21', calls: 13, leading: false },
    ]);

    const short = items.slice(0, 10);
    expect(visibleGroupItems(short, recoveredFailures(short), new Set())).toEqual(short);
  });

  it('keeps a step the reader opened visible after later calls push it out of the tail', () => {
    const items = longGroup();
    const visible = visibleGroupItems(items, recoveredFailures(items), new Set(), new Set(['call-5']));
    expect(visible.filter((item) => item.kind === 'step').map((item) =>
      item.kind === 'step' ? item.step.attempts[0]!.tools[0]!.id : '',
    )).toEqual(['call-5', 'call-20', 'call-34', 'call-35', 'call-36', 'call-37', 'call-38', 'call-39']);
    expect(visible.filter((item) => item.kind === 'gap')).toEqual([
      { kind: 'gap', firstStepId: 'call-0', calls: 5, leading: true },
      { kind: 'gap', firstStepId: 'call-6', calls: 14, leading: false },
      { kind: 'gap', firstStepId: 'call-21', calls: 13, leading: false },
    ]);
  });

});
