import { describe, expect, it, vi } from 'vitest';
import {
  detectSetupAgent,
  setupPlaceholderHtml,
  SETUP_AGENT_LABELS,
} from '../../src/sidebar/SetupMode';
import type { CliAgentName } from '../../src/agents/types';

describe('setup placeholder webview', () => {
  it('uses its single acquired VS Code API instance for both buttons', () => {
    const html = setupPlaceholderHtml(undefined);

    expect(html.match(/acquireVsCodeApi\(\)/gu)).toHaveLength(1);
    expect(html).toContain('onclick="vscode.postMessage({type:\'wizard\'})"');
    expect(html).toContain('onclick="vscode.postMessage({type:\'agent\'})"');
    expect(html).not.toMatch(/onclick="acquireVsCodeApi\(\)/u);
  });

  it('makes the detected agent the only button, with the wizard as a link', () => {
    const html = setupPlaceholderHtml('claude');

    expect(html).toContain('>Set up with an AI agent</button>');
    expect(html).toContain('>Set up without an AI agent</a>');
    expect(html).not.toContain('Run Setup Wizard');
  });

  it('keeps the wizard primary when no agent is on PATH', () => {
    const html = setupPlaceholderHtml(undefined);

    expect(html).toContain('>Run Setup Wizard</button>');
    expect(html).toContain('>Copy the AI agent setup prompt instead</a>');
  });

  it('offers no choice at all while the PATH lookup is still running', () => {
    const html = setupPlaceholderHtml('detecting');

    expect(html).toContain('Looking for Claude Code, Codex or Copilot…');
    expect(html).not.toContain('<button');
  });

  it('refuses an agent screen whose primary button is the wizard', () => {
    const html = setupPlaceholderHtml('copilot');
    const buttons = html.match(/<button[\s\S]*?<\/button>/gu) ?? [];

    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toContain("vscode.postMessage({type:'agent'})");
    expect(buttons[0]).toContain('>Set up with an AI agent</button>');
    // The agent it found is still named, in the line under the button: the
    // button says "an AI agent" because the prompt works in all three.
    expect(html).toContain('Found GitHub Copilot on this PC.');
  });

  it.each(Object.keys(SETUP_AGENT_LABELS))(
    'still reaches the wizard from the %s screen',
    (agent) => {
      const html = setupPlaceholderHtml(agent as CliAgentName);

      expect(html).toContain("vscode.postMessage({type:'wizard'})");
      expect(html).toContain('>Set up without an AI agent</a>');
    },
  );
});

describe('detectSetupAgent', () => {
  it('returns the first agent that resolves, trying claude before codex', async () => {
    const resolve = vi.fn(async (cli: string): Promise<string> => {
      if (cli === 'claude') throw new Error('claude CLI not found on PATH');
      return `C:/tools/${cli}.cmd`;
    });

    await expect(detectSetupAgent(resolve)).resolves.toBe('codex');
    expect(resolve.mock.calls.map((call) => call[0])).toEqual(['claude', 'codex']);
  });

  it('returns undefined when nothing is on PATH', async () => {
    const resolve = vi.fn(async (): Promise<string> => {
      throw new Error('CLI not found on PATH');
    });

    await expect(detectSetupAgent(resolve)).resolves.toBeUndefined();
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it('stops at the first hit and never probes the agents after it', async () => {
    const resolve = vi.fn(async (): Promise<string> => 'C:/tools/claude.cmd');

    await expect(detectSetupAgent(resolve)).resolves.toBe('claude');
    const names = resolve.mock.calls.map((call) => call[1]);
    expect(names).toEqual(['claude']);
    expect(names).not.toContain('codex');
  });
});
