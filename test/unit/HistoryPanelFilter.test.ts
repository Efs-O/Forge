import { describe, expect, it } from 'vitest';
import {
  chatRowView,
  failingJobCount,
  filterChatRows,
  filterJobRows,
  jobSearchText,
  jobStatusOf,
  noMatchMessage,
  type ChatProvenance,
} from '../../webview-ui/src/historyFilter';
import { clampPanelSize } from '../../src/sidebar/historyPanelSize';
import type { JobPanelMeta } from '../../src/sidebar/messageBridge';

function job(over: Partial<JobPanelMeta> = {}): JobPanelMeta {
  return {
    id: 'j1',
    name: 'Maya engine update',
    schedule: 'daily at 08:20',
    enabled: true,
    description: 'Job "Maya engine update" [j1]',
    lastOutcomeLabel: 'no runs yet',
    consecutiveFailures: 0,
    lastRun: null,
    runningConversationId: null,
    ...over,
  };
}

describe('who a chat row says started the chat', () => {
  it('names a known bus agent from origin_agent, whatever case it was sent in', () => {
    for (const [stored, label] of [
      ['claude', 'Claude'],
      ['Codex', 'Codex'],
      ['copilot', 'Copilot'],
    ] as const) {
      const view = chatRowView({
        title: 'Split SdServerBackend.ts',
        origin_agent: stored,
        title_source: 'prompt',
      });
      expect(view.badge).toEqual({
        label,
        kind: 'agent',
        agentClass: `history-row-badge-${label.toLowerCase()}`,
      });
      // The title is the brief's own first line, untouched: the sender is a
      // badge, not a prefix.
      expect(view.title).toBe('Split SdServerBackend.ts');
    }
  });

  it("keeps an unfamiliar bus peer's own name rather than calling it You", () => {
    // `You` would be a lie — a person did not open this chat — and a silent
    // badge would make it look like the agent chats beside it.
    const view = chatRowView({ title: 'Check the ring', origin_agent: 'miranda' });
    expect(view.badge.label).toBe('miranda');
    expect(view.badge.kind).toBe('agent');
    expect(view.badge.agentClass).toBeUndefined();
  });

  it('strips the prefix an old bus chat was named with and badges it', () => {
    for (const [stored, expected] of [
      [
        'Claude: Claude here, with an owner-approved UI task',
        'Claude here, with an owner-approved UI task',
      ],
      ['codex: retry the push', 'retry the push'],
      ['COPILOT: look at the flaky test', 'look at the flaky test'],
    ] as const) {
      const view = chatRowView({ title: stored, title_source: 'prompt' });
      expect(view.title).toBe(expected);
      expect(view.badge.kind).toBe('agent');
    }
  });

  it('leaves a name a person typed, or the retitle job gave, exactly as written', () => {
    for (const source of ['user', 'auto'] as const) {
      const title = 'Claude: what about the flaky test';
      const view = chatRowView({ title, title_source: source });
      expect(view.title).toBe(title);
      expect(view.badge).toEqual({ label: 'You', kind: 'you' });
    }
  });

  it('still badges chats whose record predates title_source', () => {
    // Records written before the field, and archive rows rebuilt from session
    // logs, carry no `title_source` at all. Insisting on `prompt` there would
    // leave every old agent chat wearing the prefix this change exists to remove.
    const view = chatRowView({ title: 'claude: fix the build' });
    expect(view.title).toBe('fix the build');
    expect(view.badge.label).toBe('Claude');
  });

  it("does not mistake another sender's name for an agent prefix", () => {
    // `Hello` is a Telegram contact, not a bus agent: stripping it would eat the
    // only words that say who the message came from.
    const title = 'Hello: Fix the Telegram ring';
    const view = chatRowView({ title, title_source: 'prompt' });
    expect(view.title).toBe(title);
    expect(view.badge).toEqual({ label: 'You', kind: 'you' });
  });

  it('leaves an ordinary chat labelled You', () => {
    expect(chatRowView({ title: 'Rename the config folder' }).badge).toEqual({
      label: 'You',
      kind: 'you',
    });
    // A title that only *looks* like a prefix, with no space after the colon, is
    // still a person's sentence.
    expect(chatRowView({ title: 'Claude:what about the test?', title_source: 'user' }).title).toBe(
      'Claude:what about the test?',
    );
  });
});

describe("the panel's search box", () => {
  const rows = [
    { id: 'a', title: 'hello man', origin_agent: 'claude' },
    { id: 'b', title: 'Second chat', title_source: 'user' as const },
    { id: 'c', title: 'Claude: retry the push', title_source: 'prompt' as const },
  ];

  it('keeps the rows whose title contains the text, case-insensitively', () => {
    expect(filterChatRows(rows, 'MAN').map((row) => row.id)).toEqual(['a']);
    expect(filterChatRows(rows, 'second').map((row) => row.id)).toEqual(['b']);
    expect(filterChatRows(rows, 'claude').map((row) => row.id)).toEqual(['a', 'c']);
  });

  it('answers to the badge as well as the title, so an agent chat is findable by who sent it', () => {
    // `a` has no `claude` in its title; its badge says Claude. A person looking
    // for the chats Claude started would otherwise get one of three.
    expect(filterChatRows([rows[2]!], 'claude').map((row) => row.id)).toEqual(['c']);
    expect(
      filterChatRows([{ title: 'Split SdServerBackend.ts', origin_agent: 'claude' }], 'claude'),
    ).toHaveLength(1);
  });

  it('an empty box shows everything, in the order the host gave it', () => {
    expect(filterChatRows(rows, '   ').map((row) => row.id)).toEqual(['a', 'b', 'c']);
  });

  it('adds the rows the host found in their saved text, without losing what the titles already answered', () => {
    const chats = [
      { id: 'a', title: 'hello man' },
      { id: 'b', title: 'second chat' },
    ];
    // `wobble` is in neither title; the host says it is in `b`'s transcript.
    expect(filterChatRows(chats, 'wobble', new Set(['b'])).map((row) => row.id)).toEqual(['b']);
    // Both halves apply at once: `MAN` is `a`'s title and `b` came from the host.
    expect(filterChatRows(chats, 'MAN', new Set(['b'])).map((row) => row.id)).toEqual(['a', 'b']);
    // An id for a chat this panel is not drawing is ignored rather than trusted:
    // the host walked the session, not the rows, and a row that has since been
    // deleted or closed must not be revived by a match nobody can see.
    expect(filterChatRows([chats[0]!], 'wobble', new Set(['gone'])).map((row) => row.id)).toEqual(
      [],
    );
    // An empty box shows everything whatever the host reported, because there is
    // nothing to filter: the content set is a filter, not an override.
    expect(filterChatRows(chats, '', new Set()).map((row) => row.id)).toEqual(['a', 'b']);
    // No set at all is the title-only rule this file has always asserted.
    expect(filterChatRows(chats, 'wobble').map((row) => row.id)).toEqual([]);
  });

  it('filters jobs on their name and their last outcome, not on the clock', () => {
    const failed = job({
      lastOutcomeLabel: 'failing ×3',
      consecutiveFailures: 3,
      lastRun: {
        at: 1,
        outcome: 'failed',
        detail: 'the /unload patch does not apply',
      },
    });
    expect(
      filterJobRows([failed, job({ id: 'j2', name: 'disk watch' })], 'Maya').map((row) => row.id),
    ).toEqual(['j1']);
    expect(filterJobRows([failed], 'unload patch').map((row) => row.id)).toEqual(['j1']);
    expect(filterJobRows([failed], 'failing').map((row) => row.id)).toEqual(['j1']);
    expect(filterJobRows([job()], 'no runs').map((row) => row.id)).toEqual(['j1']);
    // `2h ago` is on the row but not in what it is searchable by: it moves with
    // the clock, so the same search tomorrow would find nothing.
    expect(jobSearchText(failed)).not.toContain('ago');
    expect(filterJobRows([failed], '2h ago')).toEqual([]);
  });

  it('says nothing matches, quoting what was typed', () => {
    expect(noMatchMessage('zzz')).toBe('Nothing matches \"zzz\".');
    expect(noMatchMessage('  zzz  ')).toBe('Nothing matches \"zzz\".');
  });
});

describe("a job row's state", () => {
  it("reads ok, failing, never-run and skipped from the store's numbers", () => {
    expect(jobStatusOf(job({ lastRun: { at: 1, outcome: 'ok', detail: 'ran fine' } }), false)).toBe(
      'ok',
    );
    expect(
      jobStatusOf(
        job({
          lastRun: { at: 1, outcome: 'failed', detail: 'boom' },
          consecutiveFailures: 1,
          lastOutcomeLabel: 'failing ×1',
        }),
        false,
      ),
    ).toBe('failing');
    expect(jobStatusOf(job(), false)).toBe('none');
    // A skipped run is neither a success nor a failure: the dot stays hollow.
    expect(
      jobStatusOf(job({ lastRun: { at: 1, outcome: 'skipped', detail: 'busy' } }), false),
    ).toBe('none');
  });

  it("the streak wins over a single run, and this window's streaming wins over both", () => {
    // A job whose last run was ok but whose streak has not been cleared is still
    // failing — and `running` is this window's own marker, not the store's.
    expect(
      jobStatusOf(
        job({ lastRun: { at: 1, outcome: 'ok', detail: 'ran' }, consecutiveFailures: 2 }),
        false,
      ),
    ).toBe('failing');
    expect(jobStatusOf(job({ consecutiveFailures: 2 }), true)).toBe('running');
    expect(jobStatusOf(job({ lastRun: { at: 1, outcome: 'ok', detail: 'ran' } }), true)).toBe(
      'running',
    );
  });

  it('counts failing jobs for the Jobs badge', () => {
    const failing = job({
      id: 'j1',
      consecutiveFailures: 2,
      lastRun: { at: 1, outcome: 'failed', detail: 'boom' },
    });
    expect(
      failingJobCount([
        failing,
        job({ id: 'j2' }),
        job({ id: 'j3', lastRun: { at: 1, outcome: 'ok', detail: 'ran' } }),
      ]),
    ).toBe(1);
    expect(failingJobCount([])).toBe(0);
  });

  it('never reads the state out of the label text', () => {
    // The label is what `jobDescribe.ts` formats for three surfaces. A row that
    // parsed it would break the day the wording changed, so the numbers decide.
    const renamed = job({
      lastOutcomeLabel: 'broken ×2 (someone changed the wording)',
      lastRun: { at: 1, outcome: 'failed', detail: 'boom' },
      consecutiveFailures: 2,
    });
    expect(jobStatusOf(renamed, false)).toBe('failing');
    expect(jobStatusOf(job({ lastOutcomeLabel: 'ok', consecutiveFailures: 0 }), false)).toBe(
      'none',
    );
  });
});

describe('the clamp the webview applies before it uses a saved size', () => {
  it('keeps a size that fits, and pulls one that does not back inside', () => {
    expect(clampPanelSize({ width: 512, height: 640 }, 700, 900)).toEqual({
      width: 512,
      height: 640,
    });
    expect(clampPanelSize({ width: 200, height: 200 }, 700, 900)).toEqual({
      width: 260,
      height: 300,
    });
    expect(clampPanelSize({ width: 4000, height: 4000 }, 700, 900)).toEqual({
      width: 700,
      height: 900,
    });
  });

  it('a sidebar narrower than the floor wins over the floor', () => {
    // A panel that overflows its own sidebar is the worse failure than one
    // below 260 px: the plan clamps to the sidebar's width, and there is no
    // point promising 260 px of room the window cannot give.
    expect(clampPanelSize({ width: 500, height: 400 }, 240, 900)).toEqual({
      width: 240,
      height: 400,
    });
    expect(clampPanelSize({ width: 500, height: 400 }, 700, 250)).toEqual({
      width: 500,
      height: 250,
    });
  });

  it('never returns a width above what was available, at any width', () => {
    for (const available of [120, 260, 280, 480, 900, 1400]) {
      const clamped = clampPanelSize({ width: 900, height: 900 }, available, 1000);
      expect(clamped.width).toBeLessThanOrEqual(available);
      expect(clamped.width).toBeGreaterThanOrEqual(Math.min(available, 260));
    }
  });
});

describe('a chat bound to a phone conversation', () => {
  it('badges the channel rather than You, and says what is bound in its tooltip', () => {
    const row = chatRowView({ title: 'Maya engine status', origin_channel: 'telegram' });
    expect(row.badge.label).toBe('Telegram');
    expect(row.badge.agentClass).toBe('history-row-badge-telegram');
    expect(row.badge.tooltip).toBe('Bound to a Telegram chat');
    // The channel is not part of the chat's name, so the title is shown as stored.
    expect(row.title).toBe('Maya engine status');
  });

  it('badges WhatsApp its own way', () => {
    expect(chatRowView({ title: 'x', origin_channel: 'whatsapp' }).badge.label).toBe('WhatsApp');
  });

  it('a channel the panel does not show leaves the row as You', () => {
    // `fake` is the test transport. The host drops a value like this before it
    // reaches a row, and a row that did receive one still says You: nothing
    // here proves a phone opened it, and a wrong badge is worse than none.
    const odd = { title: 'x', origin_channel: 'fake' } as unknown as ChatProvenance;
    expect(chatRowView(odd).badge.label).toBe('You');
    expect(chatRowView({ title: 'x' }).badge.label).toBe('You');
  });

  it('the agent that started the chat wins over a phone binding', () => {
    // One badge slot. Who started the chat is the more specific fact, and a bus
    // brief that arrived in a Telegram-bound chat should read as that brief.
    const row = chatRowView({
      title: 'History panel redesign',
      origin_agent: 'claude',
      origin_channel: 'telegram',
    });
    expect(row.badge.label).toBe('Claude');
    expect(row.badge.tooltip).toBeUndefined();
  });

  it('an old prefixed title still beats a phone binding, and keeps its prefix stripped', () => {
    const row = chatRowView({
      title: 'Claude: History panel redesign',
      origin_channel: 'telegram',
    });
    expect(row.badge.label).toBe('Claude');
    expect(row.title).toBe('History panel redesign');
  });

  it('a phone-bound row answers a search for the channel it wears', () => {
    const rows = [
      { title: 'Maya engine status', origin_channel: 'telegram' as const },
      { title: 'Rename the config folder' },
    ];
    expect(filterChatRows(rows, 'telegram').map((row) => row.title)).toEqual([
      'Maya engine status',
    ]);
  });
});
