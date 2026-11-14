import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForgeConfigSchema } from '../../src/config/schema';
import type { ForgeConfig } from '../../src/config/types';
import { watchForgeConfig } from '../../src/vscode/configReload';

const { reload } = vi.hoisted(() => ({
  reload: { callback: undefined as undefined | ((config: ForgeConfig | null) => void) },
}));
vi.mock('../../src/config/ConfigLoader', () => ({
  watchForgeConfigPaths: (_path: string, _extra: string[], callback: typeof reload.callback) => {
    reload.callback = callback;
    return { dispose() {} };
  },
}));
afterEach(() => vi.restoreAllMocks());

describe('effective config reload', () => {
  const config = () =>
    ForgeConfigSchema.parse({
      models: [{ name: 'm', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }],
      active_model: 'm',
    });

  it('does not reapply duplicate saves, key reordering, or a restored active selection', () => {
    const current = config();
    const apply = vi.fn();
    watchForgeConfig({ configPath: 'config.yaml', getConfig: () => current, onReloaded: apply });
    reload.callback!(config());
    reload.callback!({ ...config(), active_model: null });
    reload.callback!(Object.fromEntries(Object.entries(config()).reverse()) as ForgeConfig);
    expect(apply).not.toHaveBeenCalled();
  });

  it('still applies a real setting change', () => {
    const current = config();
    const apply = vi.fn();
    watchForgeConfig({ configPath: 'config.yaml', getConfig: () => current, onReloaded: apply });
    const next = { ...config(), log_level: 'debug' as const };
    reload.callback!(next);
    expect(apply).toHaveBeenCalledExactlyOnceWith(next);
  });
});
