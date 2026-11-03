import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * An element the webview hides with React's `hidden` prop stays on screen if
 * the stylesheet gives it a `display` of its own: an author `display: flex`
 * outranks the UA sheet's `[hidden] { display: none }`. jsdom applies no
 * stylesheet, so the DOM tests saw `hidden` set and passed while 0.17.99 drew
 * the history panel at startup and could not close it. This reads the real CSS.
 */
const SRC = 'webview-ui/src';
const STYLES = 'webview-ui/styles';

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

/** The `#id` or `.class` of each element written with a `hidden={…}` prop. */
function hiddenTargets(): string[] {
  const targets = new Set<string>();
  for (const file of tsxFiles(SRC)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!/\bhidden=\{/.test(line)) return;
      // The element's own attributes sit just above the prop, inside its tag.
      for (let back = index; back >= Math.max(0, index - 6); back -= 1) {
        const text = lines[back]!;
        const id = /\bid="([\w-]+)"/.exec(text);
        const cls = /\bclassName="([\w-]+)/.exec(text);
        if (id) {
          targets.add(`#${id[1]}`);
          return;
        }
        if (cls) {
          targets.add(`.${cls[1]}`);
          return;
        }
        if (back < index && text.trimStart().startsWith('<')) break;
      }
    });
  }
  return [...targets].sort();
}

/** Every rule as `{ selectors, body }`, comments removed. */
function rules(): Array<{ selectors: string[]; body: string }> {
  const css = readdirSync(STYLES)
    .filter((name) => name.endsWith('.css'))
    .map((name) => readFileSync(join(STYLES, name), 'utf8'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: match[1]!.split(',').map((s) => s.trim()),
    body: match[2]!,
  }));
}

describe('webview elements hidden with the `hidden` prop', () => {
  it('finds the elements it guards', () => {
    expect(hiddenTargets()).toEqual(
      expect.arrayContaining(['#history-panel', '.composer-slot', '.messages-pane']),
    );
  });

  it.each(hiddenTargets())('%s hides under [hidden] whenever the CSS gives it a display', (target) => {
    const all = rules();
    const setsDisplay = all.some(
      (rule) =>
        rule.selectors.includes(target) && /(^|;)\s*display\s*:\s*(?!none)/.test(rule.body),
    );
    if (!setsDisplay) return;
    const hides = all.some(
      (rule) =>
        rule.selectors.includes(`${target}[hidden]`) && /display\s*:\s*none/.test(rule.body),
    );
    expect(hides, `${target} sets display but has no ${target}[hidden] { display: none }`).toBe(
      true,
    );
  });
});
