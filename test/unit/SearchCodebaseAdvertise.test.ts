import { describe, expect, it } from 'vitest';
import { IndexManager } from '../../src/search/IndexManager';
import { makeSearchCodebaseTool } from '../../src/tools/semanticSearchTool';
import { ToolRegistry, type ToolPermission } from '../../src/tools/ToolRegistry';
import type { EmbeddingBackend } from '../../src/backend/EmbeddingBackend';
import type { ForgeConfig } from '../../src/config/types';

/**
 * `search_codebase` had no `advertise` predicate, so every window offered it
 * even with embeddings switched off: a laptop test on 0.17.195 loaded the
 * `code_intel` group, called it, and got back
 * `Forge: embeddings are disabled. Enable the embeddings block in config.yaml
 * first.` These tests pin the predicate that replaced that wasted call.
 */

/** Cheap enough to build an IndexManager for a config read: the constructor
 *  only stores callbacks, and `applyForgeConfig` only forwards to the backend. */
function stubBackend(): EmbeddingBackend {
  return {
    start: async () => {},
    withActivity: <T>(operation: () => Promise<T>) => operation(),
    baseUrl: () => 'http://127.0.0.1:1',
    startApproval: () => undefined,
    applyForgeConfig: () => {},
  } as unknown as EmbeddingBackend;
}

function managerWith(config: Partial<ForgeConfig>): IndexManager {
  return new IndexManager(config as ForgeConfig, stubBackend());
}

const READ: Set<ToolPermission> = new Set(['read']);

function advertisedNames(indexManager: IndexManager): string[] {
  const registry = new ToolRegistry();
  registry.register(makeSearchCodebaseTool(indexManager));
  return registry.definitions(READ).map((definition) => definition.function.name);
}

describe('search_codebase advertisement', () => {
  it('refuses to advertise while the manager reports embeddings disabled', () => {
    const off = { isEnabled: () => false } as unknown as IndexManager;
    expect(makeSearchCodebaseTool(off).advertise?.()).toBe(false);
    const on = { isEnabled: () => true } as unknown as IndexManager;
    expect(makeSearchCodebaseTool(on).advertise?.()).toBe(true);
  });

  it('drops the tool from the advertised set, and brings it back, through a real registry', () => {
    expect(advertisedNames({ isEnabled: () => false } as unknown as IndexManager)).not.toContain(
      'search_codebase',
    );
    expect(advertisedNames({ isEnabled: () => true } as unknown as IndexManager)).toContain(
      'search_codebase',
    );
  });

  it('reads the flag through a real IndexManager: off, absent, or on', () => {
    expect(managerWith({ embeddings: { enabled: false } }).isEnabled()).toBe(false);
    expect(managerWith({}).isEnabled()).toBe(false);
    expect(managerWith({ embeddings: { enabled: true } }).isEnabled()).toBe(true);
    expect(advertisedNames(managerWith({ embeddings: { enabled: true } }))).toContain(
      'search_codebase',
    );
    expect(advertisedNames(managerWith({ embeddings: { enabled: false } }))).toEqual([]);
  });

  it('follows a config reload with no restart, in both directions', () => {
    const index = managerWith({ embeddings: { enabled: false } });
    expect(index.isEnabled()).toBe(false);
    index.applyForgeConfig({ embeddings: { enabled: true, model_path: 'embed.gguf' } } as ForgeConfig);
    expect(index.isEnabled()).toBe(true);
    index.applyForgeConfig({} as ForgeConfig);
    expect(index.isEnabled()).toBe(false);
  });

  it('still advertises an enabled block with no model_path, and the call names that field', async () => {
    // Deliberate: gating on model_path would hide the tool behind a message the
    // owner cannot act on, while the call-time error says exactly what to set.
    const index = managerWith({ embeddings: { enabled: true } });
    expect(index.isEnabled()).toBe(true);
    await expect(index.search('q')).rejects.toThrow('embeddings.model_path is required');
  });
});
