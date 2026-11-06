import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import {
  linkifyForRender,
  parseFileLink,
  FILE_LINK_SCHEME,
  fileLinkUrlTransform,
} from '../../webview-ui/src/linkify';

function linkedTargets(text: string): string[] {
  return [...linkifyForRender(text).matchAll(/\[([^\]]+)\]\(forge-file:\/\/[^)]*\)/g)].map(
    (m) => m[1]!,
  );
}

describe('linkifyForRender — paths', () => {
  it('links workspace-relative paths', () => {
    expect(linkedTargets('see src/sidebar/AgentLoop.ts for details')).toEqual([
      'src/sidebar/AgentLoop.ts',
    ]);
  });

  it('links Windows-style and dot-relative paths', () => {
    expect(linkedTargets('opened src\\sidebar\\App.tsx just now')).toEqual([
      'src\\sidebar\\App.tsx',
    ]);
    expect(linkedTargets('check ./config/config.yaml here')).toEqual(['./config/config.yaml']);
    expect(linkedTargets('and ../shared/util.ts too')).toEqual(['../shared/util.ts']);
  });

  it('keeps absolute roots, including Windows drives and UNC shares', () => {
    for (const target of [
      'N:\\Strata\\local\\LLM_FILES_INVENTORY.md',
      'N:\\inventory.md',
      '/tmp/inventory.md',
      '\\\\server\\share\\inventory.md',
    ]) {
      expect(linkedTargets(`see ${target}.`)).toEqual([target]);
    }
  });

  it('keeps a line suffix as part of the target', () => {
    expect(linkedTargets('failing at src/app.ts:42 now')).toEqual(['src/app.ts:42']);
    expect(linkedTargets('failing at src/app.ts:42:7 now')).toEqual(['src/app.ts:42:7']);
  });

  it('links several paths in one line', () => {
    expect(linkedTargets('edited src/a.ts and src/b.ts')).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('links a path at the very start and end of the text', () => {
    expect(linkedTargets('src/a.ts changed')).toEqual(['src/a.ts']);
    expect(linkedTargets('changed src/a.ts')).toEqual(['src/a.ts']);
  });

  it('leaves prose containing slashes alone', () => {
    for (const prose of [
      'use and/or as needed',
      'available 24/7 for you',
      'the TCP/IP stack',
      'a date like 2026/08/16 here',
      'input/output handling',
    ]) {
      expect(linkifyForRender(prose)).toBe(prose);
    }
  });

  it('does not link a bare filename with no separator', () => {
    expect(linkifyForRender('open package.json please')).toBe('open package.json please');
  });

  it('does not link an unknown extension', () => {
    expect(linkifyForRender('wrote out/thing.bin here')).toBe('wrote out/thing.bin here');
  });

  it('trims trailing sentence punctuation out of the target', () => {
    expect(linkedTargets('I changed src/a.ts.')).toEqual(['src/a.ts']);
    expect(linkedTargets('files: src/a.ts, src/b.ts.')).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('linkifyForRender — protected regions', () => {
  it('links the owner example while preserving code styling and the complete drive path', () => {
    const target = 'N:\\Strata\\local\\LLM_FILES_INVENTORY.md';
    const text = `Space list: \`${target}\`. 9`;
    const href = `${FILE_LINK_SCHEME}${encodeURIComponent(target)}`;
    expect(linkifyForRender(text)).toBe(`Space list: [\`${target}\`](${href}). 9`);
    const rendered = renderToStaticMarkup(
      createElement(Markdown, { urlTransform: fileLinkUrlTransform }, linkifyForRender(text)),
    );
    expect(rendered).toContain(`<a href="${href}"><code>${target}</code></a>`);
    expect(parseFileLink(href)).toEqual({ path: target });
  });

  it('links inline paths with spaces and line numbers', () => {
    for (const target of ['N:\\My Files\\inventory.md:9', 'src/app.ts:42']) {
      expect(linkifyForRender(`\`${target}\``)).toBe(
        `[\`${target}\`](${FILE_LINK_SCHEME}${encodeURIComponent(target)})`,
      );
    }
  });

  it('leaves fenced code blocks untouched', () => {
    const text = 'before\n\n```ts\nimport "./src/a.ts";\n```\n\nafter src/b.ts';
    const out = linkifyForRender(text);
    expect(out).toContain('import "./src/a.ts";');
    expect(linkedTargets(text)).toEqual(['src/b.ts']);
  });

  it('leaves inline code spans untouched', () => {
    const text = 'run `node src/a.ts` then edit src/b.ts';
    expect(linkifyForRender(text)).toContain('`node src/a.ts`');
    expect(linkedTargets(text)).toEqual(['src/b.ts']);
  });

  it('does not double-link an existing markdown link', () => {
    const text = '[AgentLoop](src/sidebar/AgentLoop.ts) is the owner';
    expect(linkifyForRender(text)).toBe(text);
  });

  it('handles an unterminated fence without dropping content', () => {
    const text = 'text src/a.ts\n\n```ts\nstill open src/b.ts';
    const out = linkifyForRender(text);
    expect(out).toContain('still open src/b.ts');
    expect(linkedTargets(text)).toEqual(['src/a.ts']);
  });
});

describe('linkifyForRender — urls', () => {
  it('keeps filtering executable URLs and custom schemes used as image sources', () => {
    const rendered = renderToStaticMarkup(
      createElement(
        Markdown,
        { urlTransform: fileLinkUrlTransform },
        '[bad](javascript:alert%281%29) ![bad](forge-file://src%2Fa.ts)',
      ),
    );
    expect(rendered).not.toContain('javascript:');
    expect(rendered).not.toContain('src="forge-file:');
    expect(rendered).toContain('href=""');
  });

  it('links a bare http url', () => {
    expect(linkifyForRender('see https://example.com/docs for more')).toBe(
      'see [https://example.com/docs](https://example.com/docs) for more',
    );
  });

  it('drops trailing punctuation from the url', () => {
    expect(linkifyForRender('see https://example.com.')).toBe(
      'see [https://example.com](https://example.com).',
    );
  });

  it('leaves an existing markdown link alone', () => {
    const text = '[docs](https://example.com)';
    expect(linkifyForRender(text)).toBe(text);
  });
});

describe('parseFileLink', () => {
  it('splits a path and its line', () => {
    expect(parseFileLink(`${FILE_LINK_SCHEME}${encodeURIComponent('src/a.ts:42')}`)).toEqual({
      path: 'src/a.ts',
      line: 42,
    });
  });

  it('ignores a column suffix', () => {
    expect(parseFileLink(`${FILE_LINK_SCHEME}${encodeURIComponent('src/a.ts:42:7')}`)).toEqual({
      path: 'src/a.ts',
      line: 42,
    });
  });

  it('returns just the path when there is no line', () => {
    expect(parseFileLink(`${FILE_LINK_SCHEME}${encodeURIComponent('src/a.ts')}`)).toEqual({
      path: 'src/a.ts',
    });
  });
});
