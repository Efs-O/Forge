// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

/**
 * The boot-error box shipped in each webview page (`webview-ui/index.html` and
 * `webview-ui/modelManager.html`). Both pages run before the bundle loads, so
 * their only job is to say why the bundle never came up — and what they are
 * told is an error stack or a promise rejection reason: untrusted text that
 * may contain markup.
 */
const PAGES = [
  { file: 'index.html', prefix: 'Forge webview failed to load:' },
  { file: 'modelManager.html', prefix: 'Forge Model Manager failed to load:' },
];

/** Markup, an ampersand, a quote and a real newline: what a stack can hold. */
const MESSAGE = '<b>&"x\nline2';

/** Load the page's own boot script the way the extension serves it. */
function bootWebview(file: string): JSDOM {
  const source = readFileSync(
    path.join(import.meta.dirname, '..', '..', 'webview-ui', file),
    'utf8',
  );
  const html = source
    .replace(/\$\{nonce\}/g, 'nonce-abc')
    .replace(/\$\{cspSource\}/g, 'vscode-webview-resource://csp')
    .replace(/\$\{jsUri\}/g, 'http://localhost/main.js')
    .replace(/\$\{cssUri\}/g, 'http://localhost/styles.css')
    // The bundle itself: jsdom would fetch it and there is nothing to fetch.
    .replace(/^\s*<script nonce="[^"]*" src="[^"]*"><\/script>\s*$/m, '');
  // A real url, not the default `about:blank`: with an opaque origin the page
  // throws `SecurityError: localStorage is not available for opaque origins`,
  // so the run would report that instead of what actually broke.
  return new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost/' });
}

describe('webview boot error box', () => {
  it.each(PAGES)('shows the message of $file as text, on its own line', ({ file, prefix }) => {
    const dom = bootWebview(file);
    const { window } = dom;
    try {
      window.dispatchEvent(new window.ErrorEvent('error', { message: MESSAGE }));

      const app = window.document.getElementById('app');
      expect(app).not.toBeNull();
      expect(app?.childNodes).toHaveLength(1);
      expect(app?.children).toHaveLength(1);
      expect(app?.children[0]?.tagName).toBe('DIV');
      // The `<b>` stayed text: no element was made out of the message.
      expect(app?.querySelector('b')).toBeNull();
      expect(app?.children[0]?.textContent).toBe(`${prefix}\n${MESSAGE}`);
    } finally {
      // The page's 2 s "did not initialize" timer must not outlive the test.
      window.close();
    }
  });
});
