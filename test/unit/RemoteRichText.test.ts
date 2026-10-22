import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { TELEGRAM_BOT_COMMANDS } from '../../src/remote/TelegramChannel';
import {
  HELP_SECTIONS,
  HELP_TEXT,
  REMOTE_HELP_SECTIONS,
  decorateHelpLine,
  renderRemoteHelpMenu,
  renderRemoteHelpSection,
} from '../../src/remote/remoteHelpText';
import { boldLineLabel, markupTelegramLines, sendRichText } from '../../src/remote/telegramHtml';

describe('remote rich text', () => {
  it('escapes before decorating, so content can never become markup', () => {
    const rendered = markupTelegramLines('1. a<b>&c', (line) => `<b>${line}</b>`);
    expect(rendered).toBe('<b>1. a&lt;b&gt;&amp;c</b>');
  });

  it('bolds only the labels a report owns', () => {
    const labels = new Set(['Workspace', 'Model']);
    expect(boldLineLabel('Workspace: Forge (forge)', labels)).toBe(
      '<b>Workspace:</b> Forge (forge)',
    );
    // A line whose head is not a declared label stays plain, even though it
    // holds a colon: chat titles are full of them.
    expect(boldLineLabel('Chat: notes: part two', labels)).toBe('Chat: notes: part two');
  });

  it('gives help one paragraph per group and per note, with the subject bolded', () => {
    const rendered = markupTelegramLines(HELP_TEXT, decorateHelpLine);
    expect(rendered.startsWith('<b>Forge commands:</b>')).toBe(true);
    expect(rendered).toContain('<b>Session:</b> /agents');
    expect(rendered).toContain('• <b>/stop</b> cancels');
    // Placeholders keep their angle brackets as text, or Telegram reads them
    // as an unknown tag and rejects the whole send.
    expect(rendered).toContain('/chat &lt;n-or-name&gt;');
    // No two lines of prose ever touch: every note is its own paragraph.
    for (const [index, line] of HELP_TEXT.split('\n').entries()) {
      if (!line.startsWith('•')) continue;
      expect(HELP_TEXT.split('\n')[index - 1]).toBe('');
    }
  });

  it('keeps each help section sorted, so a new command lands somewhere findable', () => {
    const sectionRe = /^([A-Za-z]+): (.+)$/u;
    for (const line of HELP_TEXT.split('\n')) {
      const match = sectionRe.exec(line);
      if (!match) continue;
      const [, label, body] = match;
      if (!HELP_SECTIONS.has(label)) continue;
      const commands = body
        .split(' · ')
        .map((entry) => entry.split(' ')[0])
        .map((entry) => entry.toLowerCase());
      expect(commands, `section "${label}" is not sorted`).toEqual([...commands].sort());
    }
  });

  it('renders the Telegram section menu and keeps every section within the Bot API limit', () => {
    const menu = renderRemoteHelpMenu();
    expect(menu.html).toContain('<b>Forge commands</b>');
    expect(menu.html).toContain('Tap a section for its commands.');
    expect(menu.html).toContain('<code>/status</code>');
    expect(menu.html).toContain('<code>/chats</code>');
    expect(menu.html).toContain('<code>/model</code>');
    expect(menu.html).toContain('<code>/stop</code>');
    expect(menu.buttons.flat().map((button) => button.callbackData)).toContain('h:s:session');
    expect(menu.buttons.at(-1)?.[0]?.callbackData).toBe('h:x');
    expect([...menu.html].length).toBeLessThan(4096);
    for (const section of REMOTE_HELP_SECTIONS) {
      const messages = renderRemoteHelpSection(section.key);
      expect(messages, section.key).toBeDefined();
      for (const message of messages ?? []) expect([...message].length).toBeLessThan(4096);
    }
    expect(renderRemoteHelpSection('missing')).toBeUndefined();
  });

  it('falls back to the plain build on a transport that does not parse HTML', async () => {
    const plain: string[] = [];
    await sendRichText(
      { send: async (_chatId, text) => void plain.push(text) },
      'chat',
      'Model: a<b>',
      (line) => `<b>${line}</b>`,
    );
    expect(plain).toEqual(['Model: a<b>']);
  });
});

/**
 * The command map lives in three places that cannot see each other: the
 * handlers, `/help`, and Telegram's native menu. Two of them had already
 * drifted — `/mirror` was implemented and documented but absent from the menu,
 * so it never appeared to anyone browsing the bot. Reading the handlers back
 * is what makes the next omission fail here instead of on a phone.
 */
describe('remote command map', () => {
  const SOURCES = [
    'src/remote/RemoteCommandHandler.ts',
    'src/remote/RemoteSessionCommands.ts',
    'src/remote/RemoteController.ts',
    // Added late: /sleep and /wake shipped working but absent from the menu
    // precisely because they live in their own file and this list did not name
    // it. Any new file holding a `command === '/x'` line belongs here too.
    'src/remote/RemotePowerCommands.ts',
    // B3: /jobs and /job live in their own file, same reason as the power one.
    'src/remote/RemoteJobCommands.ts',
    // max-lines split: the settings and model command families moved to their
    // own files, same reason as the power and job ones above.
    'src/remote/remoteSettingsCommands.ts',
    'src/remote/remoteModelCommands.ts',
    // /lock moved with the auth gate in the RemoteController split.
    'src/remote/remoteAuthGate.ts',
    // Contact management is intentionally isolated from the ordinary command
    // handler so non-owner users can never reach it.
    'src/remote/TelegramContactService.ts',
  ];
  // Aliases that still answer but are hidden from the help text and native
  // menu — two names for one thing in the command map is what made the old one
  // hard to read. `/list` and `/select` were renamed to `/chats` and `/chat`;
  // `/models` was folded into `/model` (bare `/model` lists, `/model <n>` pins),
  // but it still pages the model list on a plain-text transport, so it answers.
  const UNDOCUMENTED_ALIASES = new Set([
    '/commands',
    '/list',
    '/select',
    '/models',
    // Contact onboarding is intentionally not an owner command/menu entry.
    '/start',
    '/owner',
  ]);
  const EXTRA_IMPLEMENTED = [
    '/context',
    '/status',
    '/contact',
    '/contacts',
    '/send',
    // Phase 5: these three are dispatched through an alias map (one entry per
    // mesh alias), not a `command === '/x'` literal, so the regex above cannot
    // see them. Named here so the correspondence below still holds: the menu
    // offers them, the handler answers them, and /help documents them.
    '/claude',
    '/codex',
    '/copilot',
    '/answer',
    '/tell',
  ];

  const implemented = new Set(
    SOURCES.flatMap((file) =>
      [...readFileSync(join(process.cwd(), file), 'utf8').matchAll(/=== '(\/[a-z]+)'/gu)].map(
        (match) => match[1]!,
      ),
    )
      .concat(EXTRA_IMPLEMENTED)
      .filter((command) => !UNDOCUMENTED_ALIASES.has(command)),
  );

  it('finds the handlers it is meant to be checking', () => {
    // A regex that silently matched nothing would make both tests below pass.
    expect(implemented.size).toBeGreaterThan(20);
    expect(implemented.has('/mirror')).toBe(true);
  });

  it('keeps the menu sorted, so a new command lands somewhere findable', () => {
    const names = TELEGRAM_BOT_COMMANDS.map((entry) => entry.command as string);
    expect(names).toEqual([...names].sort());
  });

  it('documents every implemented command in /help', () => {
    const documented = new Set([...HELP_TEXT.matchAll(/(?<![\w/])(\/[a-z]+)/gu)].map((m) => m[1]!));
    expect([...implemented].filter((command) => !documented.has(command))).toEqual([]);
  });

  it('lists every Telegram menu command in /help and keeps accepted aliases explicit', () => {
    const documented = new Set([...HELP_TEXT.matchAll(/(?<![\w/])(\/[a-z]+)/gu)].map((m) => m[1]!));
    const menu = new Set(TELEGRAM_BOT_COMMANDS.map((entry) => `/${entry.command}`));
    expect([...menu].filter((command) => !documented.has(command))).toEqual([]);
    expect([...UNDOCUMENTED_ALIASES]).toEqual(
      expect.arrayContaining(['/commands', '/list', '/select', '/models', '/start', '/owner']),
    );
  });

  it('describes the queue and contact verbs accurately', () => {
    expect(HELP_TEXT).toContain('Plain text reaches the running turn at its next step');
    expect(HELP_TEXT).toContain('Tap Send now on the receipt');
    expect(HELP_TEXT).toContain('/contact approve|bind|link|disable|unbind');
  });

  it("offers every implemented command in Telegram's native menu", () => {
    const menu = new Set(TELEGRAM_BOT_COMMANDS.map((entry) => `/${entry.command}`));
    expect([...implemented].filter((command) => !menu.has(command))).toEqual([]);
    // And nothing in the menu that no handler answers.
    expect([...menu].filter((command) => !implemented.has(command))).toEqual([]);
  });
});
