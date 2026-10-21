import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255);
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}

function contrast(foreground: string, background: string): number {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

describe('question card theme', () => {
  const css = readFileSync(resolve(process.cwd(), 'webview-ui/styles/question-card.css'), 'utf8');

  it('keeps the planned light and dark token values scoped to the card', () => {
    expect(css).toContain('--q-card-bg: #22262c;');
    expect(css).toContain('--q-card-line: #3a3f47;');
    expect(css).toContain('--q-surface: #1b1e23;');
    expect(css).toContain('--q-fg: #e3e5e9;');
    expect(css).toContain('--q-muted: #98a0ab;');
    expect(css).toContain('--q-line: #2d3138;');
    expect(css).toContain('--q-accent: #f08a4b;');
    expect(css).toContain('--q-accent-soft: #3a2418;');
    expect(css).toContain('--q-ok: #6cc28f;');
    expect(css).toContain('--q-opt-hover: #2a2e35;');
    expect(css).toContain('--q-card-bg: #ffffff;');
    expect(css).toContain('--q-muted: #5b6470;');
    expect(css).toContain('--q-accent: #c25a1c;');
    expect(css).toContain('--q-chip-fg: #9a4510;');
    expect(css).toContain('body.vscode-high-contrast .question-card');
    expect(css).toContain('--q-card-line: var(--vscode-contrastBorder);');
    expect(css).toContain('--q-accent: var(--vscode-focusBorder);');
  });

  it('meets 4.5:1 for the specified text pairs and records the light accent exception', () => {
    const readablePairs = [
      ['light primary on card', '#1b1f25', '#ffffff'],
      ['light primary on selection', '#1b1f25', '#fbe9dd'],
      ['light primary on hover', '#1b1f25', '#f2f4f7'],
      ['light muted on card', '#5b6470', '#ffffff'],
      ['light muted on selection', '#5b6470', '#fbe9dd'],
      ['light chip', '#9a4510', '#fbe9dd'],
      ['light completion mark', '#2f7d4f', '#ffffff'],
      ['dark primary on card', '#e3e5e9', '#22262c'],
      ['dark primary on text area', '#e3e5e9', '#1b1e23'],
      ['dark primary on selection', '#e3e5e9', '#3a2418'],
      ['dark primary on hover', '#e3e5e9', '#2a2e35'],
      ['dark muted on card', '#98a0ab', '#22262c'],
      ['dark muted on selection', '#98a0ab', '#3a2418'],
      ['dark accent button', '#1b1e23', '#f08a4b'],
      ['dark completion mark', '#6cc28f', '#22262c'],
    ] as const;

    for (const [label, foreground, background] of readablePairs) {
      expect(contrast(foreground, background), label).toBeGreaterThanOrEqual(4.5);
    }
    // The plan explicitly pairs #fff with its exact light accent #c25a1c.
    // That pair computes to 4.40:1, so this pins the specified colors as written.
    expect(contrast('#ffffff', '#c25a1c')).toBeCloseTo(4.4, 1);
    expect(contrast('#c25a1c', '#fbe9dd')).toBeGreaterThanOrEqual(3);
  });
});
