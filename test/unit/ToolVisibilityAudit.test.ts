import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeToolUsageReports, writeToolUsageReports } from '../../src/sessions/toolUsage';
import { toolUsageCheck } from '../../src/jobs/checks/toolUsage';
import { CheckSchema } from '../../src/jobs/jobSchema';

vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
}));

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): { root: string; sessions: string; output: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tool-usage-'));
  roots.push(root);
  const sessions = path.join(root, 'sessions');
  const output = path.join(root, 'tool-usage');
  fs.mkdirSync(sessions);
  return { root, sessions, output };
}

function stamp(day: string, hour = 12): number {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year!, month! - 1, date!, hour).getTime();
}

function putSession(
  directory: string,
  filename: string,
  rows: Array<Record<string, unknown>>,
): string {
  const file = path.join(directory, `${filename}.jsonl`);
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return file;
}

describe('daily tool usage', () => {
  it('accepts the local tool_usage check kind', () => {
    expect(CheckSchema.parse({ kind: 'tool_usage' })).toEqual({ kind: 'tool_usage' });
  });

  it('skips session logs last written before the 30-day window', () => {
    const { sessions } = fixtureRoot();
    const day = '2026-10-08';
    const rows = [
      { type: 'session_start', timestamp_ms: stamp(day), forge_version: '0.17.0', model: 'm' },
      {
        role: 'assistant',
        timestamp_ms: stamp(day),
        tool_calls: [{ id: 'c1', name: 'read_file', input: { path: 'a' } }],
      },
    ];
    putSession(sessions, 'recent', rows);
    const stale = putSession(sessions, 'stale', rows);
    const old = new Date(stamp('2026-08-01'));
    fs.utimesSync(stale, old, old);

    const report = computeToolUsageReports(sessions, day).at(-1)!;
    expect(report.builds[0]!.models[0]!.sessions).toBe(1);
  });

  it('uses the replay-aware reader and groups counts by build and model', () => {
    const { sessions } = fixtureRoot();
    const day = '2026-10-08';
    const call = {
      role: 'assistant',
      timestamp_ms: stamp(day),
      tool_calls: [{ id: 'c1', name: 'shell', input: { command: 'git commit -m test' } }],
    };
    const result = {
      role: 'tool',
      timestamp_ms: stamp(day, 12) + 1,
      tool_call_id: 'c1',
      content: 'Error: refused',
    };
    putSession(sessions, 'fixture', [
      {
        type: 'session_start',
        timestamp_ms: stamp(day),
        forge_version: '0.17.0',
        model: 'local-qwen',
      },
      { type: 'tools_offered', timestamp_ms: stamp(day), names: ['shell', 'load_tool_group'] },
      call,
      result,
      { type: 'cursor', timestamp_ms: stamp(day, 12) + 2, written_count: 2 },
      { ...call, timestamp_ms: stamp(day, 13) },
      { ...result, timestamp_ms: stamp(day, 13) + 1 },
      {
        role: 'assistant',
        timestamp_ms: stamp(day, 14),
        tool_calls: [{ id: 'c2', name: 'load_tool_group', input: { group: 'media' } }],
      },
    ]);

    const report = computeToolUsageReports(sessions, day).at(-1)!;
    expect(report.builds).toHaveLength(1);
    expect(report.builds[0]).toMatchObject({
      forge_version: '0.17.0',
      models: [{ model: 'local-qwen', sessions: 1 }],
    });
    expect(report.builds[0]!.models[0]!.tools).toEqual([
      {
        tool: 'load_tool_group',
        calls: 1,
        sessions: 1,
        failures: 0,
        offered_calls: 1,
        hidden_calls: 0,
      },
      { tool: 'shell', calls: 1, sessions: 1, failures: 1, offered_calls: 1, hidden_calls: 0 },
    ]);
    expect(report.builds[0]!.models[0]!.lazy_groups).toEqual([{ group: 'media', loads: 1 }]);
    expect(report.builds[0]!.models[0]!.shell_workarounds).toEqual([{ tool: 'commit', calls: 1 }]);
  });

  it('writes deterministic files atomically and backfills at most 30 days', () => {
    const { sessions, output } = fixtureRoot();
    const endDay = '2026-10-08';
    putSession(sessions, 'old', [
      {
        type: 'session_start',
        timestamp_ms: stamp('2026-07-01'),
        forge_version: 'old',
        model: 'm',
      },
    ]);
    const first = writeToolUsageReports(sessions, output, endDay);
    const target = path.join(output, `${endDay}.json`);
    const bytes = fs.readFileSync(target);
    const rerun = writeToolUsageReports(sessions, output, endDay);

    expect(first).toHaveLength(30);
    expect(rerun).toHaveLength(30);
    expect(fs.readdirSync(output).filter((name) => name.endsWith('.json'))).toHaveLength(30);
    expect(fs.readFileSync(target).equals(bytes)).toBe(true);

    const realRename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('simulated crash before replace');
    });
    expect(() => writeToolUsageReports(sessions, output, endDay)).toThrow(
      'simulated crash before replace',
    );
    vi.mocked(fs.renameSync).mockRestore();
    expect(fs.readFileSync(target).equals(bytes)).toBe(true);
    expect(fs.renameSync).toBe(realRename);
  });

  it('writes through the tool_usage check and never reports a change', () => {
    const { sessions, output } = fixtureRoot();
    putSession(sessions, 'day', [
      {
        type: 'session_start',
        timestamp_ms: stamp('2026-10-08'),
        forge_version: '0.17.0',
        model: 'm',
      },
    ]);
    const result = toolUsageCheck(null, {
      now: new Date(2026, 9, 9, 10),
      sessionDirectory: sessions,
      outputDirectory: output,
    });

    expect(result).toEqual({
      observation: '2026-10-08',
      changed: false,
      summary: 'wrote through 2026-10-08: 1 session, 0 tool calls',
    });
    expect(fs.existsSync(path.join(output, '2026-10-08.json'))).toBe(true);
  });
});
