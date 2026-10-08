import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAskAgentPanelOpener } from '../../src/agentLinks/askAgentRuntime';

const vscodeMock = vi.hoisted(() => ({ parse: vi.fn((value: string) => value) }));
vi.mock('vscode', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vscode')>()),
  Uri: { parse: vscodeMock.parse },
}));

describe('ask_agent panel opener', () => {
  beforeEach(() => vi.clearAllMocks());

  it('opens Claude at the exact session with preferred location honored', async () => {
    const executeCommand = vi.fn(async () => undefined);
    const open = makeAskAgentPanelOpener({
      getCommands: async () => ['claude-vscode.editor.open'],
      executeCommand,
      openExternal: async () => true,
    });
    expect(await open('claude', 'session-id')).toBe('opened');
    expect(executeCommand).toHaveBeenCalledWith(
      'claude-vscode.editor.open',
      'session-id',
      undefined,
      undefined,
      undefined,
      undefined,
      { programmatic: 'honor-preferred-location' },
    );
  });

  it('reports a missing Claude command and opens Codex by local thread URI', async () => {
    const openExternal = vi.fn(async () => true);
    const open = makeAskAgentPanelOpener({
      getCommands: async () => [],
      executeCommand: vi.fn(),
      openExternal,
    });
    expect(await open('claude', 'session-id')).toBe('unavailable');
    expect(await open('codex', 'thread-id')).toBe('opened');
    expect(vscodeMock.parse).toHaveBeenCalledWith('vscode://openai.chatgpt/local/thread-id');
    expect(openExternal).toHaveBeenCalledWith('vscode://openai.chatgpt/local/thread-id');
  });
});
