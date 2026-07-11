import { describe, expect, it } from 'vitest';
import {
  HtmlDocumentBoilerplateStripper,
  stripHtmlDocumentBoilerplateFromFullText,
} from '../../src/llm/HtmlDocumentBoilerplateStripper';

describe('stripHtmlDocumentBoilerplateFromFullText', () => {
  it('returns body content for full HTML documents', () => {
    const input = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Fireworks Animation</title>
  <style>body { background: black; }</style>
</head>
<body>
  <canvas id="fireworks"></canvas>
</body>
</html>`;

    expect(stripHtmlDocumentBoilerplateFromFullText(input)).toBe(
      '<canvas id="fireworks"></canvas>',
    );
  });

  it('leaves normal markdown untouched', () => {
    const input = 'Use `<meta charset="UTF-8">` in your HTML head.';
    expect(stripHtmlDocumentBoilerplateFromFullText(input)).toBe(input);
  });
});

describe('HtmlDocumentBoilerplateStripper', () => {
  it('suppresses document boilerplate while streaming', () => {
    const stripper = new HtmlDocumentBoilerplateStripper();

    expect(
      stripper.push('<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"></head>'),
    ).toBe('');
    expect(stripper.push('<body><div>Hello</div>')).toBe('<div>Hello</div>');
    expect(stripper.push('</body></html>')).toBe('');
    expect(stripper.flush()).toBe('');
  });

  it('passes through non-document content', () => {
    const stripper = new HtmlDocumentBoilerplateStripper();
    expect(stripper.push('Plain reply')).toBe('Plain reply');
    expect(stripper.flush()).toBe('');
  });
});
