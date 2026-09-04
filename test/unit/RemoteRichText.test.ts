import { describe, expect, it } from 'vitest';
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
    expect(rendered).toContain('<b>Session:</b> /status');
    expect(rendered).toContain('• <b>/stop</b> cancels');
    // Placeholders keep their angle brackets as text, or Telegram reads them
    // as an unknown tag and rejects the whole send.
    expect(rendered).toContain('/select &lt;n-or-id&gt;');
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
