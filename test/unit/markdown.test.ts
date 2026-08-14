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
});
