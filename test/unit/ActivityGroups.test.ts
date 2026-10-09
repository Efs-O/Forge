import { describe, expect, it } from 'vitest';
import { rowKey, type ActivityGroupItem, type ActivityStep, type Row, type StepAttempt } from '../../webview-ui/src/activityRows';
import type { AppMessage } from '../../webview-ui/src/messageOps';
import { groupActivity, summarizeGroup } from '../../webview-ui/src/activityGroups';

const summarize = (items: ActivityGroupItem[]) => summarizeGroup(items);

/** Tool rounds as attempts with no reasoning before them. */
const attempts = (...rounds: AppMessage[][]): StepAttempt[] => rounds.map((tools) => ({ thoughts: [], tools }));

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

  it('passes a single step through unchanged, with surrounding thoughts', () => {
    const before: Row = { kind: 'thinkingGroup', steps: [message('thought', 'assistant', '', { reasoning: 'thinking' })] };
    const only = step('only');
    const after: Row = { kind: 'thinkingGroup', steps: [message('tail', 'assistant', '', { reasoning: 'tail' })] };
    expect(groupActivity([before, only, after])).toEqual([before, only, after]);
  });

  it('passes a thinking-only run through unchanged', () => {
    const rows: Row[] = [
      { kind: 'thinkingGroup', steps: [message('a', 'assistant', '', { reasoning: 'a' })] },
      { kind: 'thinkingGroup', steps: [message('b', 'assistant', '', { reasoning: 'b' })] },
    ];
    expect(groupActivity(rows)).toEqual(rows);
  });

  it('includes interleaved thinking rows and preserves every item in order', () => {
    const first = step('first');
    const thought: Row = { kind: 'thinkingGroup', steps: [message('thought', 'assistant', '', { reasoning: 'ponder' })] };
    const second = step('second');
    const grouped = groupOf(first, thought, second);
    expect(grouped.kind).toBe('activityGroup');
    if (grouped.kind === 'activityGroup') {
      expect(grouped.items.map((item) => item.kind)).toEqual(['step', 'thinkingGroup', 'step']);
      expect(grouped.items.flatMap((item) => item.kind === 'step'
        ? item.step.attempts.flatMap((a) => a.tools).map((tool) => tool.id)
        : item.steps.map((msg) => msg.id))).toEqual(['first-tool', 'thought', 'second-tool']);
    }
  });

  it('keeps the group key anchored to the first message as a step is appended', () => {
    const firstStep = { kind: 'step' as const, step: { attempts: attempts([message('first', 'tool', 'call')]), diffs: [] } };
    const appended = { kind: 'step' as const, step: { attempts: attempts([message('later', 'tool', 'call')]), diffs: [] } };
    const beforeAppend = groupOf(firstStep, { kind: 'thinkingGroup', steps: [message('middle', 'assistant')] });
    const afterAppend = groupOf(firstStep, { kind: 'thinkingGroup', steps: [message('middle', 'assistant')] }, appended);
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

  it('reports thinking with measured time and without measurement', () => {
    const timed = summarize([
      {
        kind: 'step',
        step: {
          attempts: [{
            thoughts: [message('thought', 'assistant', '', { reasoning: 'x', reasoningMs: 20_000 })],
            tools: [message('timed-tool', 'tool', 'call', { toolResultTotal: 1 })],
          }],
          diffs: [],
        },
      },
      { kind: 'thinkingGroup', steps: [message('other-thought', 'assistant', '', { reasoning: 'y', reasoningMs: 69_000 })] },
    ]);
    expect(timed).toMatchObject({ hasThinking: true, thinking: '89 s' });

    const untimed = summarize([{
      kind: 'thinkingGroup',
      steps: [message('thought', 'assistant', '', { reasoning: 'x' })],
    }]);
    expect(untimed).toMatchObject({ hasThinking: true, thinking: '' });
    expect(summarize([{ kind: 'step', step: { attempts: [], diffs: [] } }]).hasThinking).toBe(false);
  });
});
