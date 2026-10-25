import { describe, expect, it } from 'vitest';
import { setupPlaceholderHtml } from '../../src/sidebar/SetupMode';

describe('setup placeholder webview', () => {
  it('uses its single acquired VS Code API instance for both buttons', () => {
    const html = setupPlaceholderHtml();

    expect(html.match(/acquireVsCodeApi\(\)/gu)).toHaveLength(1);
    expect(html).toContain('onclick="vscode.postMessage({type:\'wizard\'})"');
    expect(html).toContain('onclick="vscode.postMessage({type:\'agent\'})"');
    expect(html).not.toMatch(/onclick="acquireVsCodeApi\(\)/u);
  });
});
