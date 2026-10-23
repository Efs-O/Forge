import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobSchema, JobStateSchema, type JobFile } from '../../src/jobs/jobSchema';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import type { RemoteCommandContext } from '../../src/remote/RemoteCommandHandler';
import { handleRemoteSessionCommand } from '../../src/remote/RemoteSessionCommands';
import {
  renderRemoteContextReport,
  renderRemoteStatusReport,
} from '../../src/remote/remoteStatusReport';
import { formatSelectionPage } from '../../src/remote/remoteSelectionFormat';
import { formatRemoteRelativeDate } from '../../src/remote/RemoteDateTime';
import { renderRemoteJobCard, renderRemoteJobList } from '../../src/remote/remoteJobReport';
import { parseTelegramJobCallback, telegramJobHash } from '../../src/remote/TelegramJobButtons';
import { textBar, formatTokensShort, contextRing } from '../../src/remote/telegramReportFormat';
import { formatSystemReport } from '../../src/system/formatSystemReport';
import type { SystemReport } from '../../src/system/SystemReport';
import type { RemoteInboundEvent } from '../../src/remote/types';
import type { ModelPickerDescriptor } from '../../src/sidebar/ModelPickerGroups';
import {
  renderRemoteHelpMenu,
  renderRemoteHelpSection,
  REMOTE_HELP_SECTIONS,
} from '../../src/remote/remoteHelpText';
import { escapeTelegramHtml } from '../../src/remote/telegramHtml';

afterEach(() => vi.useRealTimers());

describe('Telegram readable report formatters', () => {
  it('formats bounded bars and short token counts', () => {
    expect(textBar(0.5, 12)).toBe('██████░░░░░░');
    expect(textBar(0.5, 16)).toBe('████████░░░░░░░░');
    expect(textBar(Number.NaN, 4)).toBe('░░░░');
    expect(textBar(4, 2)).toBe('██');
    expect(formatTokensShort(167_012)).toBe('167K');
    expect(formatTokensShort(1_500_000)).toBe('1.5M');
  });

  it('maps the context percentage to the five ring glyphs without capping truth', () => {
    const cases: Array<[number, string]> = [
      [0, '○ 0%'], [12, '○ 12%'], [13, '◔ 13%'], [37, '◔ 37%'],
      [38, '◑ 38%'], [62, '◑ 62%'], [63, '◕ 63%'], [87, '◕ 87%'],
      [88, '● 88%'], [100, '● 100%'], [104, '● 104%'],
    ];
    for (const [percent, expected] of cases) expect(contextRing(percent, 100)).toBe(expected);
    expect(contextRing(1, 0)).toBeUndefined();
    expect(contextRing(1, -1)).toBeUndefined();
  });

  it('renders status counts in order, drops zeros, and escapes every dynamic value', () => {
    const report = renderRemoteStatusReport({
      workspaceName: 'demo <app>',
      workspaceAlias: 'a&b',
      conversation: {
        id: 'a3f9c2e1-1234',
        title: `${'x'.repeat(45)}<bad>`,
        activeModel: 'qwen<&>',
        requestCount: 31,
        toolCallCount: 23,
        compactCount: 1,
        activeMs: 12 * 60_000,
      },
      running: 2,
      queued: 0,
      streaming: 1,
      crashUnknown: 1,
      notificationsPending: 2,
      abandoned: 0,
      context: { used: 167_012, max: 400_000 },
      clanker: false,
      exchanges: 'Exchanges: <agent>&',
    });

    expect(report.html).toContain('<b>Workspace</b> demo &lt;app&gt; (a&amp;b)');
    expect(report.html).toContain(`<b>Chat</b> ${'x'.repeat(39)}… · a3f9c2e1`);
    expect(report.html).toContain('<b>Model</b> qwen&lt;&amp;&gt;');
    expect(report.html).toContain('<b>Now</b> 2 running · 1 streaming');
    expect(report.html).toContain('1 crash-unknown · 2 notifications pending');
    expect(report.html).toContain('167K of 400K · 233K left');
    expect(report.html).toContain('<b>Work</b> 12 min active · 31 requests · 23 tool calls · 1 compaction');
    expect(report.html).toContain('Exchanges: &lt;agent&gt;&amp;');
    expect(report.html).not.toContain('0 queued');
    expect(report.html).not.toContain('<bad>');
  });

  it('marks an unbound status idle and gives clanker its own visible line', () => {
    const report = renderRemoteStatusReport({
      running: 0,
      queued: 0,
      streaming: 0,
      notificationsPending: 0,
      abandoned: 0,
      clanker: true,
      exchanges: 'Exchanges: none',
    });
    expect(report.html).toContain('<b>Chat</b> No chat bound');
    expect(report.html).toContain('<b>Now</b> Idle · nothing queued');
    expect(report.html).toContain('<b>Approvals: CLANKER</b>');
    expect(report.html).not.toContain('crash-unknown');
    expect(report.html).not.toContain('Exchanges');
    expect(report.plain).toContain('Approvals: CLANKER');
  });

  it('adds the context ring to the /status title in HTML and plain text only when available', () => {
    const withBudget = renderRemoteStatusReport({
      running: 0, queued: 0, streaming: 0, notificationsPending: 0, abandoned: 0,
      context: { used: 31, max: 100 }, clanker: false, exchanges: 'Exchanges: none',
    });
    expect(withBudget.html.split('\n')[0]).toBe('<b>Status</b> · ◔ 31%');
    expect(withBudget.plain.split('\n')[0]).toBe('Status · ◔ 31%');
    const withoutBudget = renderRemoteStatusReport({
      running: 0, queued: 0, streaming: 0, notificationsPending: 0, abandoned: 0,
      clanker: false, exchanges: 'Exchanges: none',
    });
    expect(withoutBudget.html.split('\n')[0]).toBe('<b>Status</b>');
    expect(withoutBudget.plain.split('\n')[0]).toBe('Status');
  });

  it('omits an unavailable context bar and omits missing breakdown data', () => {
    const unavailable = renderRemoteContextReport({ model: 'model<&>' });
    expect(unavailable.html).toContain('Context unavailable (no num_ctx for this model)');
    expect(unavailable.html).not.toContain('<pre>');
    expect(unavailable.html).toContain('model&lt;&amp;&gt;');

    const withoutParts = renderRemoteContextReport({
      model: 'qwen',
      budget: { used: 75_000, max: 100_000 },
    });
    expect(withoutParts.html).toContain('75K of 100K · 25K left');
    expect(withoutParts.html).not.toContain('What fills it');

    const withParts = renderRemoteContextReport({
      model: 'qwen',
      budget: { used: 100_000, max: 100_000 },
      breakdown: { instructions: 9_000, tools: 23_000, conversation: 68_000 },
      compactAt: 0.8,
    });
    expect(withParts.html).toContain('<b>What fills it</b>');
    expect(withParts.html).toContain('Auto-compaction at 80% (80K).');
    expect(withParts.plain).toContain('Conversation');
  });

  it('formats all picker kinds with current markers, clipping, relative dates and safe HTML', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-22T12:00:00'));
    expect(formatRemoteRelativeDate(Date.now() - 5 * 60_000)).toBe('5 min ago');
    expect(formatRemoteRelativeDate(Date.now() - 2 * 60 * 60_000)).toBe('2 h ago');
    expect(formatRemoteRelativeDate(Date.now() - 24 * 60 * 60_000)).toBe('yesterday');
    expect(formatRemoteRelativeDate(Date.now() - 6 * 24 * 60 * 60_000)).toBe('Friday');
    expect(formatRemoteRelativeDate(Date.now() - 8 * 24 * 60 * 60_000)).toBe('Oct 14');
    const modelEntries = [
      { name: 'alpha<&>', group: 'Local — llama.cpp', profiles: ['audit'] },
    ] as ModelPickerDescriptor[];
    const conversations = [
      {
        id: 'chat-1',
        title: `${'Long title '.repeat(7)}<x>\nsecond line`,
        activeModel: 'alpha<&>',
        archived: true,
        updatedAt: Date.now() - 5 * 60_000,
      },
    ];
    const context = {
      modelEntries,
      workspaceAliases: { dev: 'Dev <workspace>' },
      currentWorkspaceAlias: 'dev',
      currentWorkspaceName: 'Dev <workspace>',
      currentModel: 'alpha<&>',
      currentConversationId: 'chat-1',
      conversations,
      buttons: true,
    };
    const chats = formatSelectionPage(context, 'conversations', ['chat-1'], 0);
    expect(chats.html).toContain('<b>Chats</b> <i>· 1–1 of 1</i>');
    expect(chats.html).toContain('● current');
    expect(chats.html).toContain('alpha&lt;&amp;&gt; · 5 min ago · archived');
    expect(chats.html).not.toContain('<x>');
    expect(chats.controls('abcdefghijkl').pickIndexes).toEqual([0]);

    const models = formatSelectionPage(context, 'models', ['alpha<&>'], 0);
    expect(models.html).toContain('<b>Local — llama.cpp</b>');
    expect(models.html).toContain('<b>1.</b> alpha&lt;&amp;&gt; · @audit · ● current');
    const workspaces = formatSelectionPage(context, 'workspaces', ['dev'], 0);
    expect(workspaces.html).toContain('dev — Dev &lt;workspace&gt; · ● current');
  });

  it('renders Telegram-only system cards without changing the regular report', () => {
    const report: SystemReport = {
      collectedAt: 0,
      gpus: [
        {
          index: 0,
          name: 'NVIDIA GeForce <GPU>',
          memoryUsedMb: 8_000,
          memoryTotalMb: 16_000,
          utilizationPercent: 94,
          temperatureC: 61,
        },
        {
          index: 1,
          name: 'Idle board',
          memoryUsedMb: 0,
          memoryTotalMb: 8_000,
          utilizationPercent: 2,
          temperatureC: 42,
        },
      ],
      gpuError: null,
      vramProcesses: [
        {
          pid: 7,
          name: 'llama<&>.exe',
          bytes: 4 * 1024 ** 3,
          gpuIndex: 0,
          forgeModel: 'qwen<&>',
        },
      ],
      vramProcessError: null,
      ram: { totalBytes: 16 * 1024 ** 3, freeBytes: 8 * 1024 ** 3 },
      drives: [
        { drive: 'C:<', freeBytes: 312 * 1024 ** 3, totalBytes: 1_000 * 1024 ** 3 },
        { drive: 'Z:', freeBytes: 0, totalBytes: 0 },
      ],
      minVramBytes: 150 * 1024 ** 2,
    };
    const cards = formatSystemReport(report, { telegramCards: true });
    expect(cards).toContain('<b>GPU 0 · &lt;GPU&gt;</b>');
    expect(cards).toContain('<b>GPU 1 · Idle board</b>');
    expect(cards).toContain('Load 2% · idle · 42°C');
    expect(cards).toContain('Load 94% · 61°C');
    expect(cards).toContain('llama&lt;&amp;&gt;.exe · qwen&lt;&amp;&gt;');
    expect(cards).toContain('<b>Memory</b>');
    expect(cards).toContain('<b>Drives</b>');
    expect(cards).toContain('312 GB free');
    expect(cards).toContain('Empty drives (0 GB) are hidden.');
    expect(cards).not.toContain('pid 7');
    expect(formatSystemReport(report)).toContain('GPU 0');
    expect(escapeTelegramHtml('a<&>')).toBe('a&lt;&amp;&gt;');
  });

  it('renders escaped job lists and cards with identity-bound action buttons', () => {
    const file: JobFile = {
      job: JobSchema.parse({
        version: 1,
        id: 'disk',
        name: 'Disk <watch>',
        schedule: { kind: 'interval', minutes: 15 },
        check: { kind: 'disk_space', path: 'C:\\', min_free_gb: 10 },
        on_change: { kind: 'notify' },
        updated_at: 7,
      }),
      state: JobStateSchema.parse({
        last_run_at: 1_000,
        last_ok_at: 1_000,
        last_observation: '<result &>'.repeat(500),
        consecutive_failures: 2,
        next_due_at: 2_000,
      }),
    };
    const list = renderRemoteJobList([file], new Date(10_000));
    expect(list.html).toContain('<b>1.</b> Disk &lt;watch&gt;');
    expect(list.html).toContain('<b>failing ×2</b>');
    expect(parseTelegramJobCallback(list.buttons[0]![0]!.callbackData)).toEqual({
      index: 0,
      hash: telegramJobHash('disk'),
    });
    const card = renderRemoteJobCard(file, 0, new Date(10_000));
    expect(card.html).toContain('<b>Disk &lt;watch&gt;</b>');
    expect(card.html).toContain('<blockquote expandable>');
    expect(card.html).toContain('&lt;result &amp;&gt;');
    expect(card.html.length).toBeLessThan(3_200);
    expect(card.buttons.flat().map((button) => parseTelegramJobCallback(button.callbackData)?.action)).toEqual([
      'r', 'p', 'c', 'd', 'l', undefined,
    ]);
  });
});
