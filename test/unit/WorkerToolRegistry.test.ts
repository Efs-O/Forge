import { describe, expect, it } from 'vitest';
import type { ForgeConfig } from '../../src/config/types';
import { makeListWorkerModelsTool } from '../../src/tools/dispatchWorkersTool';
import { ToolRegistry, type RegisteredTool } from '../../src/tools/ToolRegistry';

function workerTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'dispatch_workers',
        description: 'test',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    permission: 'delegate',
    additionalPermissions: ['read'],
    additionalPermissionsForArgs: (args) => {
      const workers = args['workers'];
      return Array.isArray(workers) &&
        workers.some(
          (worker) =>
            typeof worker === 'object' &&
            worker !== null &&
            (worker as Record<string, unknown>)['access'] === 'write',
        )
        ? ['write']
        : [];
    },
    handler: async () => 'ok',
  };
}

describe('worker tool registry enforcement', () => {
  it('lists exact eligible worker models without sensitive config fields', async () => {
    const config: ForgeConfig = {
      active_model: 'local-model',
      llama_server: {},
      permissions: { agents: { delegate: true, cloud_workers: false } },
      profiles: { worker: { think: false } },
      aliases: { legacy: 'local-model@worker' },
      models: [
        { name: 'local-model', gguf_path: 'N:/secret/model.gguf' },
        {
          name: 'cloud-model',
          provider: 'openai',
          endpoint: 'https://secret.invalid',
          api_key_secret: 'secret-key-name',
        },
      ],
    };
    const registry = new ToolRegistry();
    registry.register(makeListWorkerModelsTool(() => config));

    expect(registry.definitions(new Set(['delegate'])).map((item) => item.function.name)).toEqual([
      'list_worker_models',
    ]);
    const result = JSON.parse(
      await registry.dispatch('list_worker_models', {}, new Set(['delegate'])),
    ) as Array<Record<string, unknown>>;
    expect(result).toEqual([
      {
        name: 'local-model',
        route: 'local-llama',
        cloud: false,
        profiles: ['worker'],
        aliases: ['legacy'],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('.gguf');
  });

  it('keeps model catalog advertisement and results live across config reloads', async () => {
    let config: ForgeConfig = { active_model: null, llama_server: {}, models: [] };
    const registry = new ToolRegistry();
    registry.register(makeListWorkerModelsTool(() => config));
    expect(registry.definitions(new Set(['delegate']))).toEqual([]);

    config = {
      active_model: 'cloud-model',
      llama_server: {},
      permissions: { agents: { delegate: true, cloud_workers: true } },
      models: [{ name: 'cloud-model', provider: 'ollama' }],
    };
    expect(registry.definitions(new Set(['delegate']))).toHaveLength(1);
    const result = JSON.parse(
      await registry.dispatch('list_worker_models', {}, new Set(['delegate'])),
    ) as Array<Record<string, unknown>>;
    expect(result[0]).toMatchObject({ name: 'cloud-model', route: 'local-ollama' });
  });

  it('advertises on static minimum permissions and enforces write from arguments', async () => {
    const registry = new ToolRegistry();
    registry.register(workerTool());
    expect(
      registry.definitions(new Set(['delegate', 'read'])).map((item) => item.function.name),
    ).toEqual(['dispatch_workers']);
    await expect(
      registry.dispatch(
        'dispatch_workers',
        { workers: [{ access: 'read' }] },
        new Set(['delegate', 'read']),
      ),
    ).resolves.toBe('ok');
    await expect(
      registry.dispatch(
        'dispatch_workers',
        { workers: [{ access: 'write' }] },
        new Set(['delegate', 'read']),
      ),
    ).rejects.toThrow('permission "write"');
  });

  it('rejects a registered tool outside the active worker scope', async () => {
    const registry = new ToolRegistry();
    registry.register(workerTool());
    const allowed = new Set(['delegate', 'read', 'write'] as const);
    await expect(
      registry.dispatch('dispatch_workers', {}, allowed, undefined, {
        allowedNames: new Set(['read_file']),
      }),
    ).rejects.toThrow('outside the active tool scope');
  });
});
