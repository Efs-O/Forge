import { describe, expect, it } from 'vitest';
import { normalizeMarkdownForRender } from '../../webview-ui/src/markdown';

describe('normalizeMarkdownForRender', () => {
  it('turns a streamed code fence attached to prose into a Markdown block', () => {
    expect(normalizeMarkdownForRender('I ran it.```text\nPath\n----\nN:\\Forge\n```')).toBe(
      'I ran it.\n\n```text\nPath\n----\nN:\\Forge\n```',
    );
  });

  it('leaves already valid fenced blocks unchanged', () => {
    const markdown = 'I ran it.\n\n```text\nPath\n```';
    expect(normalizeMarkdownForRender(markdown)).toBe(markdown);
  });

  it('leaves answer layout and ordinary prose untouched', () => {
    const answer = 'Confirmed against git status — my ownership and yours, exactly:\n**Mine:**';
    const prose = 'The fix is ready.\nIt handles saved messages too.';
    const code = '```text\nThe fix is ready.\n**Details**\n```';
    expect(normalizeMarkdownForRender(answer)).toBe(answer);
    expect(normalizeMarkdownForRender(prose)).toBe(prose);
    expect(normalizeMarkdownForRender(code)).toBe(code);
  });
});
