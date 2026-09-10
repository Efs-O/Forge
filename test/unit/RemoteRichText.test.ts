import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { TELEGRAM_BOT_COMMANDS } from '../../src/remote/TelegramChannel';
import { HELP_TEXT, decorateHelpLine } from '../../src/remote/remoteHelpText';
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
    expect(rendered).toContain('<b>Session:</b> /help');
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
  ];
  // Aliases and the parser-dispatched command have no `command === ...` line.
  // `/list` and `/select` were renamed to `/chats` and `/chat`; they still
  // answer, so muscle memory and old screenshots keep working, but they are
  // deliberately absent from both the help text and the native menu — two names
  // for one thing in the command map is what made the old one hard to read.
  const UNDOCUMENTED_ALIASES = new Set(['/commands', '/list', '/select']);
  const EXTRA_IMPLEMENTED = ['/steer'];

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
    expect(implemented.has('/steer')).toBe(true);
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

  it("offers every implemented command in Telegram's native menu", () => {
    const menu = new Set(TELEGRAM_BOT_COMMANDS.map((entry) => `/${entry.command}`));
    expect([...implemented].filter((command) => !menu.has(command))).toEqual([]);
    // And nothing in the menu that no handler answers.
    expect([...menu].filter((command) => !implemented.has(command))).toEqual([]);
  });
});
