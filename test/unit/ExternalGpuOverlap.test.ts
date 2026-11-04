/**
 * The GPU-aware unload rule (`docs/plans/ENGINE_GPU_AWARE_UNLOAD_PLAN.md`).
 *
 * Before a request to a managed external server Forge used to unload EVERY other
 * managed server, which was right while every Strata entry wanted the same two
 * cards and wrong once the owner runs a coder on the 3060 beside production on
 * the 5060s: the first request to one unloaded the other, forever. An engine may
 * now name the device indexes it occupies, and a server is unloaded only when
 * those sets share an index. These tests pin both halves of that, and above all
 * the safe default: a MISSING `gpus` means "overlaps everything", so a config
 * that has not added the field behaves exactly as it did before. A later change
 * that made a missing `gpus` mean "no GPUs" (never unload) fails test 1's
 * undefined cases and test 4's "no `gpus` unloads A" — that is the plan's
 * State × lifecycle row for the `delete`/`disable` columns.
 *
 * Kept apart from `ExternalModelServers.test.ts`, which is already long, per the
 * plan. The context setup is copied from that file's own pool tests rather than
 * imported across test files.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { EngineConfigSchema, ENGINE_EXEC_FIELDS } from '../../src/config/engineSchema';
import { ModelConfigSchema } from '../../src/config/modelSchema';
import { resolveModelEntry } from '../../src/config/ConfigResolver';
import { gpusOverlap } from '../../src/backend/poolAcquisition';
import { ExternalModelServers } from '../../src/backend/ExternalModelServers';
import {
  prepareExternalForRequest,
  type ExternalCoordinationContext,
} from '../../src/backend/BackendPoolExternal';
import { SharedRuntimeRegistry } from '../../src/backend/SharedRuntimeRegistry';
import type { ForgeConfig } from '../../src/config/types';

vi.mock('vscode', () => ({
  window: {
    showWarningMessage: () => Promise.resolve(undefined),
    createOutputChannel: () => ({ appendLine: () => {}, clear: () => {}, show: () => {} }),
  },
}));

describe('gpusOverlap', () => {
  it('treats a missing answer as overlapping everything', () => {
    // The old behaviour, and the one a config without `gpus` still gets: an
    // unanswered question unloads, it never lets two servers share a card.
    expect(gpusOverlap(undefined, undefined)).toBe(true);
    expect(gpusOverlap(undefined, [2])).toBe(true);
    expect(gpusOverlap([0, 1], undefined)).toBe(true);
  });

  it('reports an overlap only for a shared device index', () => {
    expect(gpusOverlap([0, 1], [2])).toBe(false);
    expect(gpusOverlap([0, 1], [1, 2])).toBe(true);
  });
});

describe('the engine schema owns gpus, and a model entry may not carry it', () => {
  it('accepts a device list', () => {
    expect(EngineConfigSchema.safeParse({ gpus: [2] }).success).toBe(true);
    expect(EngineConfigSchema.safeParse({ gpus: [0, 1] }).success).toBe(true);
    // Absent is the whole point: an engine that says nothing overlaps everything.
    expect(EngineConfigSchema.safeParse({ unload_path: '/unload' }).success).toBe(true);
  });

  it('rejects an empty list, a negative, a fraction, a repeat and a string', () => {
    for (const bad of [[], [-1], [1.5], [0, 0], '2']) {
      expect(EngineConfigSchema.safeParse({ gpus: bad }).success).toBe(false);
    }
    // The duplicate case is a refine, so its message has to name the field the
    // owner has to fix.
    const dup = EngineConfigSchema.safeParse({ gpus: [0, 0] });
    expect(dup.error?.issues[0]?.message).toContain('gpus');
  });

  it('is not an exec field, so the migration never moves it', () => {
    // `gpus` decides nothing about which program runs, so it is not in the list
    // `policyMigration.ts` writes and a model entry carrying one is a plain
    // schema error rather than an exec field to fold.
    expect((ENGINE_EXEC_FIELDS as readonly string[]).includes('gpus')).toBe(false);
  });

  it('refuses gpus on a config.yaml model entry, as a never-typed field', () => {
    const parsed = ModelConfigSchema.safeParse({
      name: 'strata-coder',
      provider: 'openai-compatible',
      endpoint: 'http://127.0.0.1:8090',
      unload_path: '/unload',
      gpus: [2],
    });
    expect(parsed.success).toBe(false);
    const issue = parsed.error?.issues[0];
    // The message has to name where the key belongs: a bare "unrecognized key"
    // would leave the owner hunting for the line inside config.yaml.
    expect(issue?.message).toBe(
      'gpus belongs on the engine in ~/.forge/policy.yaml, not on a model entry',
    );
    // `z.never`, not `z.any().refine(() => false)`: an `any`-based field would put
    // `gpus?: any` in the inferred entry type, and it reports a 'custom' issue
    // instead of a type one. This is the runtime signature of the never type —
    // test files are outside `tsconfig.json`, so no compile-time check here could
    // have caught the difference.
    expect(issue?.code).toBe('invalid_type');
    expect((issue as { expected?: string } | undefined)?.expected).toBe('never');
    // Absent is still fine: the field simply is not a model field.
    expect(
      ModelConfigSchema.safeParse({
        name: 'strata-coder',
        provider: 'openai-compatible',
        endpoint: 'http://127.0.0.1:8090',
        unload_path: '/unload',
      }).success,
    ).toBe(true);
  });
});

/** One config for the resolver and lookup tests: three managed models on three
 *  engines, two of which name their cards and one of which does not. */
function gpuConfig(): ForgeConfig {
  return {
    models: [
      {
        name: 'strata-prod',
        provider: 'openai-compatible',
        endpoint: 'http://127.0.0.1:8080',
        engine: 'strata-5060',
      },
      {
        name: 'strata-coder',
        provider: 'openai-compatible',
        endpoint: 'http://127.0.0.1:8090',
        engine: 'strata-3060',
      },
      {
        name: 'strata-quiet',
        provider: 'openai-compatible',
        endpoint: 'http://127.0.0.1:8091',
        engine: 'strata-unlisted',
      },
    ],
    engines: {
      'strata-5060': { start_command: ['node', 'prod.js'], unload_path: '/unload', gpus: [0, 1] },
      'strata-3060': { start_command: ['node', 'coder.js'], unload_path: '/unload', gpus: [2] },
      'strata-unlisted': { start_command: ['node', 'quiet.js'], unload_path: '/unload' },
    },
    active_model: 'strata-prod',
    llama_server: { port: 9100 },
  } as ForgeConfig;
}

describe('the engine supplies gpus to the resolved model', () => {
  it('folds gpus in with the other engine fields', () => {
    expect(resolveModelEntry(gpuConfig(), 'strata-coder')?.gpus).toEqual([2]);
    expect(resolveModelEntry(gpuConfig(), 'strata-prod')?.gpus).toEqual([0, 1]);
    // An engine that names no cards leaves the field absent, which the overlap
    // rule reads as "wants every card".
    expect(resolveModelEntry(gpuConfig(), 'strata-quiet')?.gpus).toBeUndefined();
  });

  it('answers gpusOf from the resolver, not from config.models', () => {
    const config = gpuConfig();
    const servers = new ExternalModelServers(
      () => config,
      async () => undefined,
      async () => new Response('{}', { status: 200 }),
    );
    expect(servers.gpusOf('strata-coder')).toEqual([2]);
    expect(servers.gpusOf('strata-quiet')).toBeUndefined();
    // Not a managed server at all: no cards, and nothing to unload.
    expect(servers.gpusOf('no-such-model')).toBeUndefined();
  });
});

describe('prepareExternalForRequest unloads only an overlapping server', () => {
  /**
   * A managed-server board this window can talk to, without a real pool: the
   * shape `BackendPool.externalContext()` hands, with no local slots (this is
   * the managed-to-managed case) and nothing busy.
   */
  function makeCtx(
    external: ExternalModelServers,
    registry: SharedRuntimeRegistry,
  ): ExternalCoordinationContext {
    return {
      external,
      slots: new Map(),
      ollamaSlots: new Map(),
      sharedSlots: new Map(),
      registry,
      sharedRuntimeEnabled: false,
      runtimeKey: () => 'k',
      freeSlot: () => {},
      isBusy: () => false,
      isDelegationPinned: () => false,
      isOllamaModel: () => false,
    };
  }

  /** A managed external this window has loaded, with what its engine says. */
  function fakeExternal(spec: Array<{ name: string; gpus?: number[] }>): {
    external: ExternalModelServers;
    unloaded: string[];
    started: string[];
  } {
    const unloaded: string[] = [];
    const started: string[] = [];
    const byName = new Map(spec.map((entry) => [entry.name, entry]));
    const external = {
      isManaged: (name: string) => byName.has(name),
      managedNames: () => spec.map((entry) => entry.name),
      reconcileForFree: async () => {},
      loadedNames: () => spec.map((entry) => entry.name),
      gpusOf: (name: string) => byName.get(name)?.gpus,
      unload: async (name: string) => {
        unloaded.push(name);
      },
      ensureStarted: async (name: string) => {
        started.push(name);
      },
      markInUse: () => {},
    } as unknown as ExternalModelServers;
    return { external, unloaded, started };
  }

  /**
   * A turn hold belonging to ANOTHER window, written by hand: `acquireExternalTurnHold`
   * always records this process's pid, and the registry here reports any pid alive
   * so the foreign record is not reclaimed as abandoned.
   */
  function heldByOtherWindow(
    dir: string,
    model: string,
    title = 'Other window chat',
  ): SharedRuntimeRegistry {
    const registry = new SharedRuntimeRegistry(dir, () => true);
    const id = '999999-other-window';
    const holds = path.join(dir, 'external-turn-holds');
    fs.mkdirSync(holds, { recursive: true });
    fs.writeFileSync(
      path.join(holds, `${id}.json`),
      JSON.stringify({
        id,
        model,
        pid: 999999,
        conversationId: 'other-window-chat',
        title,
        expiresAt: Date.now() + 60_000,
      }),
    );
    return registry;
  }

  /** A machine-wide board in a folder the test removes. */
  async function withBoard(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gpu-overlap-'));
    try {
      await run(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('leaves a server on other cards loaded', async () => {
    await withBoard(async (dir) => {
      const { external, unloaded, started } = fakeExternal([
        { name: 'strata-prod', gpus: [0, 1] },
        { name: 'strata-coder', gpus: [2] },
      ]);
      const registry = new SharedRuntimeRegistry(dir, () => true);
      await prepareExternalForRequest('strata-coder', makeCtx(external, registry));
      // The whole point of the change: production keeps its model, and the
      // coder still starts, because no card is shared.
      expect(unloaded).toEqual([]);
      expect(started).toEqual(['strata-coder']);
    });
  });

  it('unloads a server that shares one card', async () => {
    await withBoard(async (dir) => {
      const { external, unloaded } = fakeExternal([
        { name: 'strata-prod', gpus: [0, 1] },
        { name: 'strata-mid', gpus: [1] },
      ]);
      const registry = new SharedRuntimeRegistry(dir, () => true);
      await prepareExternalForRequest('strata-mid', makeCtx(external, registry));
      expect(unloaded).toEqual(['strata-prod']);
    });
  });

  it('unloads a server whose engine named no cards (the old behaviour)', async () => {
    await withBoard(async (dir) => {
      const { external, unloaded } = fakeExternal([
        { name: 'strata-prod' },
        { name: 'strata-coder', gpus: [2] },
      ]);
      const registry = new SharedRuntimeRegistry(dir, () => true);
      await prepareExternalForRequest('strata-coder', makeCtx(external, registry));
      expect(unloaded).toEqual(['strata-prod']);
    });
  });

  it('is not blocked by a cross-window turn on other cards', async () => {
    await withBoard(async (dir) => {
      const { external, unloaded, started } = fakeExternal([
        { name: 'strata-prod', gpus: [0, 1] },
        { name: 'strata-coder', gpus: [2] },
      ]);
      const registry = heldByOtherWindow(dir, 'strata-prod');
      await prepareExternalForRequest('strata-coder', makeCtx(external, registry));
      // The layer above the unload bug: without this filter a production turn
      // in another window refused every coder load outright.
      expect(started).toEqual(['strata-coder']);
      expect(unloaded).toEqual([]);
    });
  });

  it('is still blocked by a cross-window turn that shares a card', async () => {
    await withBoard(async (dir) => {
      const { external, unloaded, started } = fakeExternal([
        { name: 'strata-prod', gpus: [0, 1] },
        { name: 'strata-mid', gpus: [1] },
      ]);
      const registry = heldByOtherWindow(dir, 'strata-prod');
      await expect(
        prepareExternalForRequest('strata-mid', makeCtx(external, registry)),
      ).rejects.toThrow(/strata-prod is serving chat 'Other window chat' right now/);
      // Refused before any free or any start: the GPUs stay as they were.
      expect(unloaded).toEqual([]);
      expect(started).toEqual([]);
    });
  });

  it('is still blocked by a cross-window turn whose engine named no cards', async () => {
    await withBoard(async (dir) => {
      const { external, started } = fakeExternal([
        { name: 'strata-prod' },
        { name: 'strata-coder', gpus: [2] },
      ]);
      const registry = heldByOtherWindow(dir, 'strata-prod');
      await expect(
        prepareExternalForRequest('strata-coder', makeCtx(external, registry)),
      ).rejects.toThrow(/strata-prod is serving chat/);
      expect(started).toEqual([]);
    });
  });

  it('leaves no turn hold behind when the load is refused', async () => {
    await withBoard(async (dir) => {
      const { external } = fakeExternal([
        { name: 'strata-prod', gpus: [0, 1] },
        { name: 'strata-mid', gpus: [1] },
      ]);
      const registry = heldByOtherWindow(dir, 'strata-prod');
      await expect(
        prepareExternalForRequest('strata-mid', makeCtx(external, registry)),
      ).rejects.toThrow(/serving chat/);
      // Only the foreign record remains: a refused load must not leave this
      // window's own claim on the board, or every other window would stay off
      // these GPUs until this one closes.
      expect(registry.externalTurnHolders().map((hold) => hold.model)).toEqual(['strata-prod']);
    });
  });

  // The turn hold is taken at turn start, BEFORE the request reaches
  // `prepareExternalForRequest`. When only that function learned about GPUs, this
  // check still refused any other model, so a coder turn on GPU 2 failed every
  // time a production turn was running on GPUs 0/1 (2026-11-03).
  describe('acquireExternalTurnHold applies the same overlap rule', () => {
    const cards: Record<string, number[] | undefined> = {
      'strata-prod': [0, 1],
      'strata-coder': [2],
      'strata-mid': [1],
      'strata-quiet': undefined,
    };
    const sharesWith = (model: string) => (other: string) =>
      gpusOverlap(cards[model], cards[other]);

    it('takes a hold beside a turn on other cards', async () => {
      await withBoard(async (dir) => {
        const registry = heldByOtherWindow(dir, 'strata-prod');
        const lease = await registry.acquireExternalTurnHold(
          'strata-coder',
          'coder-chat',
          'Coder chat',
          sharesWith('strata-coder'),
        );
        expect(
          registry
            .externalTurnHolders()
            .map((hold) => hold.model)
            .sort(),
        ).toEqual(['strata-coder', 'strata-prod']);
        lease.release();
      });
    });

    it('refuses a hold beside a turn that shares a card', async () => {
      await withBoard(async (dir) => {
        const registry = heldByOtherWindow(dir, 'strata-prod');
        await expect(
          registry.acquireExternalTurnHold(
            'strata-mid',
            'mid-chat',
            'Mid chat',
            sharesWith('strata-mid'),
          ),
        ).rejects.toThrow(/strata-prod is serving chat 'Other window chat' right now/);
      });
    });

    it('refuses a hold when either engine named no cards', async () => {
      await withBoard(async (dir) => {
        const registry = heldByOtherWindow(dir, 'strata-quiet');
        await expect(
          registry.acquireExternalTurnHold(
            'strata-coder',
            'coder-chat',
            'Coder chat',
            sharesWith('strata-coder'),
          ),
        ).rejects.toThrow(/strata-quiet is serving chat/);
      });
    });
  });
});
