import { describe, expect, it } from 'vitest';
import { toCompactRows, type ActivityGroupItem } from '../../webview-ui/src/activityRows';
import { foldRuns, runLabel } from '../../webview-ui/src/activityRuns';
import type { AppMessage } from '../../webview-ui/src/messageOps';

function tool(id: string, name: string, target: string, fields: Partial<AppMessage> = {}): AppMessage {
  return {
    id,
    role: 'tool',
    content: `${name} → ${target}`,
    toolName: name,
    toolTarget: target,
    toolResultTotal: 10,
    toolCallId: `call-${id}`,
    ...fields,
  };
}

/** Each tool message is its own round, as when the model thinks between calls. */
function items(messages: AppMessage[]): ActivityGroupItem[] {
  const rounds = messages.flatMap((m): AppMessage[] =>
    m.role === 'tool'
      ? [{ id: `think-${m.id}`, role: 'assistant', content: '', reasoning: 'next' }, m]
      : [m],
  );
  return toCompactRows(rounds).flatMap((row): ActivityGroupItem[] =>
    row.kind === 'step' ? [{ kind: 'step', step: row.step }] : [],
  );
}

const cd = 'cd "n:/vs code apps/hb-runs/forge" && ';

describe('foldRuns', () => {
  it('folds back-to-back successful calls of one tool and labels the programs', () => {
    const folded = foldRuns(
      items([
        tool('a', 'shell', `${cd}grep -n "fn" a.html`),
        tool('b', 'shell', `${cd}sed -n '1,9p' a.html`),
        tool('c', 'shell', `${cd}grep -n "co" a.html`),
        tool('d', 'shell', `${cd}sed -n 5p a.html`),
      ]),
    );
    expect(folded).toHaveLength(1);
    const run = folded[0]!;
    expect(run.kind).toBe('run');
    if (run.kind !== 'run') return;
    expect(run.steps).toHaveLength(4);
    expect(runLabel(run.toolName, run.steps)).toBe('grep, sed');
  });

  it('keeps a failure, an edit and a running call on their own rows', () => {
    const folded = foldRuns(
      items([
        tool('a', 'shell', 'grep x f'),
        tool('b', 'shell', 'grep y f', { toolIsError: true }),
        tool('c', 'shell', 'grep z f'),
        tool('e', 'edit_file', 'f.html'),
        { id: 'de', role: 'diff', content: 'f.html', toolCallId: 'call-e' },
        tool('f', 'shell', 'sed -n 1p f'),
        tool('g', 'shell', 'sed -n 2p f', { toolResultTotal: undefined }),
      ]),
    );
    expect(folded.map((item) => item.kind)).toEqual(['step', 'step', 'step', 'step', 'step', 'step']);
  });

  it('starts a new run when the tool changes and lists targets for other tools', () => {
    const folded = foldRuns(
      items([
        tool('a', 'read_file', 'a.html'),
        tool('b', 'read_file', 'b.css'),
        tool('c', 'shell', 'grep x f'),
        tool('d', 'shell', 'grep y f'),
      ]),
    );
    expect(folded.map((item) => item.kind)).toEqual(['run', 'run']);
    const first = folded[0]!;
    if (first.kind !== 'run') throw new Error('expected a run');
    expect(runLabel(first.toolName, first.steps)).toBe('a.html, b.css');
  });

  it('leaves a single quiet step unfolded', () => {
    expect(foldRuns(items([tool('a', 'shell', 'grep x f')])).map((item) => item.kind)).toEqual([
      'step',
    ]);
  });
});
