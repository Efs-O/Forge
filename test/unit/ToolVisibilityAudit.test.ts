import { describe, expect, it } from 'vitest';
// Standalone audit code is plain ESM so Node and Vitest exercise the same functions.
// @ts-expect-error -- the standalone script intentionally has no TypeScript declarations
import { auditSessions, dedupeRows, pairCalls, workaroundTargets } from '../../scripts/tool-visibility-audit.mjs';

const at = (timestamp_ms: number, row: object) => ({ timestamp_ms, ...row });
const offered = (timestamp_ms: number, names: string[]) => at(timestamp_ms, { type: 'tools_offered', names });
const call = (timestamp_ms: number, id: string, name: string, input = {}) =>
  at(timestamp_ms, { role: 'assistant', tool_calls: [{ id, name, input }] });

describe('tool visibility audit', () => {
  it('collapses a cursor replay and pairs results by id even when result order differs', () => {
    const first = call(10, 'first', 'read_file');
    const second = call(11, 'second', 'shell');
    const rows = dedupeRows([
      first, second, at(12, { role: 'tool', tool_call_id: 'second', content: 'exit 0 · 0.1 s' }),
      at(13, { role: 'tool', tool_call_id: 'first', content: 'Error: missing' }),
      at(14, { type: 'cursor', written_count: 4 }),
      at(20, { ...first, timestamp_ms: 20 }), at(21, { ...second, timestamp_ms: 21 }),
      at(22, { role: 'tool', tool_call_id: 'second', content: 'exit 0 · 0.1 s' }),
      at(23, { role: 'tool', tool_call_id: 'first', content: 'Error: missing' }),
    ]);
    expect(pairCalls(rows)).toHaveLength(2);
    expect(pairCalls(rows).map(({ result }: { result: { tool_call_id: string } }) => result.tool_call_id))
      .toEqual(['first', 'second']);
  });

  it('collapses an older contiguous replay without erasing a lone repeated row', () => {
    const user = at(1, { role: 'user', content: 'continue' });
    const assistant = at(2, { role: 'assistant', content: 'done' });
    expect(dedupeRows([user, assistant, at(3, user), at(4, assistant)]))
      .toEqual([user, assistant]);
    expect(dedupeRows([user, at(3, user)])).toHaveLength(2);
  });

  it('uses only offered sessions as the denominator and keeps never-offered tools unmeasured', () => {
    const report = auditSessions([
      { id: 'a', rows: [offered(1, ['shell']), call(2, 'a', 'shell', { command: 'git commit -m x' }),
        at(3, { role: 'tool', tool_call_id: 'a', content: 'exit 0 · 0.1 s' })] },
      { id: 'b', rows: [offered(1, ['commit']), call(2, 'b', 'commit'),
        at(3, { role: 'tool', tool_call_id: 'b', content: 'Error: refused' })] },
      { id: 'c', rows: [offered(1, ['shell']), call(2, 'c', 'shell', { command: 'git commit -m y' })] },
    ], ['shell', 'commit', 'render_html_to_image'], 1);
    const commit = report.tools.find((item: { tool: string }) => item.tool === 'commit');
    expect(commit).toMatchObject({ sessionsOffered: 1, sessionsCalled: 1, calls: 1,
      failures: 1, workaroundCalls: 2, workaroundSessions: 2 });
    expect(report.tools.find((item: { tool: string }) => item.tool === 'render_html_to_image'))
      .toMatchObject({ sessionsOffered: 'unmeasured', sessionsCalled: 'unmeasured',
        calls: 'unmeasured', failures: 'unmeasured' });
  });

  it('uses prior visibility after --since and excludes sessions that later offer the tool', () => {
    const report = auditSessions([{ id: 'a', rows: [offered(1, ['shell']),
      call(5, 'a', 'shell', { command: 'mkdir a' }),
      offered(6, ['shell', 'create_directory']),
      call(7, 'b', 'shell', { command: 'mkdir b' }),
    ] }], ['shell', 'create_directory'], 5);
    expect(report.tools.find((item: { tool: string }) => item.tool === 'create_directory'))
      .toMatchObject({ sessionsOffered: 1, workaroundCalls: 0 });
  });

  it('matches workaround words as tokens, including logged Node script source', () => {
    expect(workaroundTargets('npm i three')).toContain('render_html_to_image');
    expect(workaroundTargets('npm install three@0.128.0 --no-save')).toContain('render_html_to_image');
    expect(workaroundTargets('pnpm add playwright')).toContain('render_html_to_image');
    expect(workaroundTargets('node scripts/preview.mjs', {
      'scripts/preview.mjs': "import { chromium } from 'playwright';",
    })).toContain('render_html_to_image');
    expect(workaroundTargets('git mv a b')).toContain('move_file');
    expect(workaroundTargets('New-Item foo -ItemType Directory')).toContain('create_directory');
    expect(workaroundTargets('Start-Sleep -Seconds 3')).toContain('background wait');
    expect(workaroundTargets('rm scratch.txt')).toContain('delete_file');
    expect(workaroundTargets('git rm scratch.txt')).not.toContain('delete_file');
    expect(workaroundTargets('npm i threesome')).not.toContain('render_html_to_image');
    expect(workaroundTargets('git commitment')).not.toContain('commit');
    expect(workaroundTargets('mkdirish foo')).not.toContain('create_directory');
  });

  it('recognizes a logged heredoc Node script without reading workspace files', () => {
    const report = auditSessions([{ id: 'script', rows: [
      offered(1, ['shell']),
      call(2, 'write', 'shell', { command: "cat > preview.mjs <<'EOF'\nimport * as three from 'three';\nEOF" }),
      call(3, 'run', 'shell', { command: 'node preview.mjs' }),
    ] }], ['shell', 'render_html_to_image'], 1);
    expect(report.tools.find((item: { tool: string }) => item.tool === 'render_html_to_image'))
      .toMatchObject({ workaroundCalls: 1, workaroundSessions: 1 });
  });
});
