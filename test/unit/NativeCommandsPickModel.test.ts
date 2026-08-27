import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ForgeConfig } from '../../src/config/types';

/**
 * `forge.pickModel` classifies the chosen model to decide what to do with it:
 * a CLI agent or cloud model is just announced, anything local is acquired
 * through the backend pool. Both that decision and the provider shown in the
 * quick pick used the RAW config entry, but `provider` is routinely inherited
 * from a `group` and group merge runs at request time — so every grouped model
 * read as llama.cpp.
 */

const commands = new Map<string, (...args: unknown[]) => unknown>();
const quickPicks: Array<Array<{ label: string; description?: string }>> = [];
const infoMessages: string[] = [];

vi.mock('vscode', () => ({
  commands: {
    registerCommand: (id: string, cb: (...args: unknown[]) => unknown) => {
      commands.set(id, cb);
      return { dispose: () => {} };
    },
  },
  window: {
    showQuickPick: async (items: Array<{ label: string; description?: string }>) => {
      quickPicks.push(items);
      return items[0];
    },
    showInformationMessage: async (msg: string) => {
      infoMessages.push(msg);
      return undefined;
    },
    showErrorMessage: async () => undefined,
    createOutputChannel: () => ({ appendLine: () => {}, clear: () => {}, show: () => {} }),
    activeTextEditor: undefined,
  },
  workspace: { workspaceFolders: [], getConfiguration: () => ({ get: () => undefined }) },
  Uri: { file: (p: string) => ({ fsPath: p }) },
}));

const { registerNativeCommands } = await import('../../src/vscode/nativeCommands');

function makeConfig(): ForgeConfig {
  return {
    models: [{ name: 'grouped-cli-agent', group: 'cli-board' }],
    groups: { 'cli-board': { provider: 'cli' } },
    active_model: null,
    llama_server: { port: 8080 },
  } as ForgeConfig;
}

function register(config: ForgeConfig): { acquired: string[] } {
  const acquired: string[] = [];
  const deps = {
    backend: {
      acquire: async (name: string) => {
        acquired.push(name);
        return {} as never;
      },
      stopAll: async () => {},
    },
    sidebar: { switchModel: async () => {} },
    statusBar: { setStarting: () => {}, setReady: () => {}, setError: () => {} },
    getConfig: () => config,
    getConfigPath: () => 'config.yaml',
    setConfig: () => {},
  };
  registerNativeCommands({ subscriptions: [] } as never, deps as never);
  return { acquired };
}

describe('forge.pickModel provider classification', () => {
  beforeEach(() => {
    commands.clear();
    quickPicks.length = 0;
    infoMessages.length = 0;
  });

  it('resolves the provider through the model’s group', async () => {
    const config = makeConfig();
    const { acquired } = register(config);

    await commands.get('forge.pickModel')!();

    // The quick pick labels it by what it actually is, not "llama.cpp".
    expect(quickPicks[0]?.[0]?.description).toBe('cli');
    // And a CLI agent is announced, never handed to the llama.cpp backend pool.
    expect(acquired).toEqual([]);
    expect(infoMessages[0]).toContain('external CLI agent');
  });
});
