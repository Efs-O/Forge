/**
 * Every DirectBackend used to lazily create its own "Forge - llama-server"
 * output channel, and nothing disposed them. Observed live: four identically
 * named entries in the Output dropdown after a handful of spawn/stop cycles —
 * and with several slots live at once the real ones are indistinguishable from
 * each other and from the dead ones.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const created: string[] = [];
const disposed: string[] = [];

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: (name: string) => {
      created.push(name);
      return {
        appendLine: () => {},
        clear: () => {},
        show: () => {},
        dispose: () => disposed.push(name),
      };
    },
  },
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
}));

const { DirectBackend, disposeServerChannel } = await import('../../src/backend/DirectBackend');

const config = {
  active_model: 'm',
  llama_server: { binary: 'llama-server.exe', host: '127.0.0.1', port: 8080 },
  models: [{ name: 'm', provider: 'llama.cpp', gguf_path: 'N:/models/m.gguf' }],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture, not a real ForgeConfig
} as any;

describe('the llama-server output channel', () => {
  beforeEach(() => {
    created.length = 0;
    disposed.length = 0;
    disposeServerChannel();
    created.length = 0;
    disposed.length = 0;
  });

  it('is created once no matter how many backends exist', () => {
    for (let port = 8080; port < 8084; port++) {
      new DirectBackend(config, port).showConsole();
    }
    expect(created.filter((n) => n === 'Forge - llama-server')).toHaveLength(1);
  });

  it('is disposed on deactivate, and recreated cleanly afterwards', () => {
    new DirectBackend(config, 8080).showConsole();
    expect(created).toHaveLength(1);

    disposeServerChannel();
    expect(disposed).toEqual(['Forge - llama-server']);

    // A reload in the same host must get a working channel, not a disposed one.
    new DirectBackend(config, 8080).showConsole();
    expect(created).toHaveLength(2);
  });
});
