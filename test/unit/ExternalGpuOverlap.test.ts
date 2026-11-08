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
import { ExternalTurnHolds } from '../../src/backend/ExternalTurnHolds';
import {
  prepareExternalForRequest,
  unloadManagedForLocalLoad,
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
      // Production wires a publisher into the real servers; a fake says which way
      // this window leans (BL-032): a window that cannot publish its own changes
      // may not trust a residency map, because its own loads never reach the token.
      residencyPublicationTrusted: () => true,
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

  /**
   * BL-032: the residency re-read is a network wait — a 2 s read of `/v1/models` per
   * endpoint and a second 2 s read of `/v1/status` when the list comes back empty — and
   * the machine-wide turn-hold lock is the only thing another window's first managed
   * turn waits on, with a 5 s deadline. Four of those seconds spent inside the lock
   * left that waiter one second and made it fail outright. These two tests pin the
   * lock's discipline: the probe runs outside it, and the cross-window hold check and
   * every free still run inside it.
   */
  describe('the residency probe and the machine-wide lock', () => {
    /** A registry that reports, for anything called while its lock is held, that it is. */
    function lockAwareRegistry(
      dir: string,
      isAlive: (pid: number) => boolean = () => true,
    ): {
      registry: SharedRuntimeRegistry;
      held: () => boolean;
    } {
      const registry = new SharedRuntimeRegistry(dir, isAlive);
      let held = false;
      const real = registry.withExternalTurnHoldLock.bind(registry);
      const wrapped = <T,>(fn: () => Promise<T>): Promise<T> =>
        real(async () => {
          held = true;
          try {
            return await fn();
          } finally {
            held = false;
          }
        });
      registry.withExternalTurnHoldLock = wrapped;
      return { registry, held: () => held };
    }

    it('re-reads residency before the lock and frees inside it', async () => {
      await withBoard(async (dir) => {
        const { external, unloaded } = fakeExternal([
          { name: 'strata-prod', gpus: [0, 1] },
          { name: 'strata-mid', gpus: [1] },
        ]);
        const { registry, held } = lockAwareRegistry(dir);
        const events: string[] = [];
        const recording = external as unknown as {
          reconcileForFree: () => Promise<void>;
          unload: (name: string) => Promise<void>;
        };
        recording.reconcileForFree = async () => {
          events.push(held() ? 'reconcile:inside' : 'reconcile:outside');
        };
        recording.unload = async (name: string) => {
          events.push(held() ? `unload:inside:${name}` : `unload:outside:${name}`);
          unloaded.push(name);
        };
        await prepareExternalForRequest('strata-mid', makeCtx(external, registry));
        expect(events).toEqual(['reconcile:outside', 'unload:inside:strata-prod']);
        expect(unloaded).toEqual(['strata-prod']);
      });
    });

    it('re-reads residency before the lock when a local model frees them all', async () => {
      await withBoard(async (dir) => {
        const events: string[] = [];
        const { registry, held } = lockAwareRegistry(dir);
        // A token this window can read, and nothing published during the probe: this
        // is the fast path, where the map is trusted and nothing is added to it.
        registry.bumpExternalResidencyGeneration();
        const external = {
          isManaged: () => true,
          managedNames: () => ['strata-prod', 'strata-mid'],
          residencyPublicationTrusted: () => true,
          loadedNames: () => ['strata-prod'],
          reconcileForFree: async () => {
            events.push(held() ? 'reconcile:inside' : 'reconcile:outside');
          },
          unloadAll: async (_alreadyReconciled?: boolean, names?: readonly string[]) => {
            events.push(`unloadAll:inside:${(names ?? ['from-map']).join('+')}`);
          },
        } as unknown as ExternalModelServers;
        await unloadManagedForLocalLoad('local-gguf', makeCtx(external, registry));
        // The map's one name, not the managed list: a map this window can prove
        // current decides, and the probe ran outside the lock (BL-032).
        expect(events).toEqual(['reconcile:outside', 'unloadAll:inside:strata-prod']);
      });
    });

    /**
     * Another window's ENTIRE managed turn — hold acquired, model loaded into VRAM,
     * hold released — inside this window's residency probe. A cross-window hold check
     * alone cannot see any of it: by the time this window takes the lock the record is
     * gone, and the model is resident in a server this window last saw unloaded. This
     * is the sequence Codex named when rejecting the probe move (BL-032), and what the
     * residency-change token is for.
     */
    function otherWindowManagedTurn(
      dir: string,
      registry: SharedRuntimeRegistry,
      model: string,
    ): void {
      const holds = path.join(dir, 'external-turn-holds');
      fs.mkdirSync(holds, { recursive: true });
      const file = path.join(holds, '999999-other-window.json');
      fs.writeFileSync(
        file,
        JSON.stringify({
          id: '999999-other-window',
          model,
          pid: 999999,
          conversationId: 'other-window-chat',
          title: 'Other window chat',
          expiresAt: Date.now() + 60_000,
        }),
      );
      registry.bumpExternalResidencyGeneration(); // that window's markInUse: now resident
      fs.rmSync(file, { force: true }); // and its turn is over, so the hold is gone
    }

    it('frees the server the map missed when another window loaded and released during the probe', async () => {
      await withBoard(async (dir) => {
        const { external, unloaded } = fakeExternal([
          { name: 'strata-prod', gpus: [0, 1] },
          { name: 'strata-mid', gpus: [1] },
        ]);
        const { registry, held } = lockAwareRegistry(dir);
        // A token published before the probe, so this test proves the token did the
        // work and not merely a file that has never been written.
        registry.bumpExternalResidencyGeneration();
        const events: string[] = [];
        const recording = external as unknown as {
          reconcileForFree: () => Promise<void>;
          loadedNames: () => string[];
          unload: (name: string) => Promise<void>;
        };
        // This window's map exactly as its probe left it: strata-prod looks unloaded.
        recording.loadedNames = () => [];
        recording.reconcileForFree = async () => {
          events.push(held() ? 'reconcile:inside' : 'reconcile:outside');
          // Another window's WHOLE turn — hold acquired, model loaded into VRAM,
          // hold released — lands after this probe read the board. By the time this
          // window takes the lock there is nothing left to find: no hold, and the
          // map says unloaded. This is the sequence a hold check alone cannot see.
          otherWindowManagedTurn(dir, registry, 'strata-prod');
        };
        recording.unload = async (name: string) => {
          events.push(held() ? `unload:inside:${name}` : `unload:outside:${name}`);
          unloaded.push(name);
        };
        await prepareExternalForRequest('strata-mid', makeCtx(external, registry));
        // A map that cannot be proved current is not used: the frees offer every
        // overlapping managed server, so strata-prod comes off the cards strata-mid
        // is about to load onto. The probe still ran exactly once, and outside the
        // lock — BL-032's stall is gone, and so is the missed unload.
        expect(events).toEqual(['reconcile:outside', 'unload:inside:strata-prod']);
        expect(unloaded).toEqual(['strata-prod']);
      });
    });

    it('frees every managed server for a local load on the same evidence', async () => {
      await withBoard(async (dir) => {
        const events: string[] = [];
        const { registry, held } = lockAwareRegistry(dir);
        registry.bumpExternalResidencyGeneration();
        const external = {
          isManaged: () => true,
          managedNames: () => ['strata-prod'],
          residencyPublicationTrusted: () => true,
          loadedNames: () => [], // the probe saw nothing resident
          reconcileForFree: async () => {
            events.push(held() ? 'reconcile:inside' : 'reconcile:outside');
            otherWindowManagedTurn(dir, registry, 'strata-prod');
          },
          unloadAll: async (_alreadyReconciled?: boolean, names?: readonly string[]) => {
            events.push(`unloadAll:inside:${(names ?? ['from-map']).join('+')}`);
          },
        } as unknown as ExternalModelServers;
        await unloadManagedForLocalLoad('local-gguf', makeCtx(external, registry));
        // The managed names, not the map: `unloadAll` frees exactly what it is
        // given, and this window's map still says nothing is loaded.
        expect(events).toEqual(['reconcile:outside', 'unloadAll:inside:strata-prod']);
      });
    });

    it('trusts the map when nothing was published during the probe', async () => {
      await withBoard(async (dir) => {
        const { external, unloaded } = fakeExternal([
          { name: 'strata-prod', gpus: [0, 1] },
          { name: 'strata-mid', gpus: [1] },
        ]);
        const { registry } = lockAwareRegistry(dir);
        registry.bumpExternalResidencyGeneration();
        const recording = external as unknown as { loadedNames: () => string[] };
        recording.loadedNames = () => [];
        await prepareExternalForRequest('strata-mid', makeCtx(external, registry));
        // No over-unloading for its own sake: a map this window can prove current
        // still decides which servers to offer, so a server on those cards survives.
        expect(unloaded).toEqual([]);
      });
    });

    it('frees conservatively when no token can be read at all', async () => {
      await withBoard(async (dir) => {
        const { external, unloaded } = fakeExternal([
          { name: 'strata-prod', gpus: [0, 1] },
          { name: 'strata-mid', gpus: [1] },
        ]);
        const { registry } = lockAwareRegistry(dir);
        const recording = external as unknown as { loadedNames: () => string[] };
        recording.loadedNames = () => [];
        await prepareExternalForRequest('strata-mid', makeCtx(external, registry));
        // An absent token means "cannot prove", never "nothing changed": it also
        // covers a publisher whose write failed, because that removes the file.
        expect(unloaded).toEqual(['strata-prod']);
      });
    });

    it('publishes a token when a dead host\'s turn hold is reclaimed', async () => {
      await withBoard(async (dir) => {
        const reader = heldByOtherWindow(dir, 'strata-prod'); // a hold from pid 999999
        reader.bumpExternalResidencyGeneration();
        const before = reader.externalResidencyGeneration();
        // That host died: its turn ends with no release to publish, so the reclaim
        // is the only publication that can reach a window holding a stale map.
        const reclaimer = new SharedRuntimeRegistry(dir, () => false);
        expect(reclaimer.externalTurnHolders()).toEqual([]);
        expect(reader.externalResidencyGeneration()).not.toBe(before);
      });
    });

    it('publishes a residency-change token that differs on every change, and on a lost file', async () => {
      await withBoard(async (dir) => {
        const registry = new SharedRuntimeRegistry(dir, () => true);
        const absent = registry.externalResidencyGeneration();
        expect(absent).toBe('');
        registry.bumpExternalResidencyGeneration();
        const first = registry.externalResidencyGeneration();
        expect(first).not.toBe(absent);
        registry.bumpExternalResidencyGeneration();
        // Two tokens are never equal, so a write lost to a concurrent bump can only
        // cost one extra unload, never hide a change.
        expect(registry.externalResidencyGeneration()).not.toBe(first);
        // A publisher that could not write removes the file, so a reader holding the
        // old token sees "cannot prove" rather than the token it already had.
        fs.rmSync(path.join(dir, 'external-turn-holds', '.residency-generation'), {
          force: true,
        });
        expect(registry.externalResidencyGeneration()).not.toBe(first);
      });
    });

    it('publishes a token when a turn hold is released', async () => {
      await withBoard(async (dir) => {
        const registry = new SharedRuntimeRegistry(dir, () => true);
        registry.bumpExternalResidencyGeneration();
        const lease = registry.claimExternalTurnHold('strata-prod', 'chat-1', 'a turn');
        const token = registry.externalResidencyGeneration();
        expect(token).not.toBe('');
        lease.release();
        // The release is the moment the model becomes resident with no record left
        // to point at it, so it is the publication a stale map must not miss.
        expect(registry.externalResidencyGeneration()).not.toBe(token);
      });
    });

    it('publishes before it removes a released hold, so no reader can scan the gap', async () => {
      await withBoard(async (dir) => {
        // `claimExternalTurnHold` is only ever called inside the machine-wide lock,
        // which creates this folder; a bare test has to create it too.
        fs.mkdirSync(path.join(dir, 'external-turn-holds'), { recursive: true });
        const holds = new ExternalTurnHolds(dir, () => true);
        const lease = holds.claimExternalTurnHold('strata-prod', 'chat-1', 'a turn');
        const records = () =>
          fs
            .readdirSync(path.join(dir, 'external-turn-holds'))
            .filter((name) => name.endsWith('.json'));
        const real = holds.bumpExternalResidencyGeneration.bind(holds);
        const publishedWhileHeld: number[] = [];
        holds.bumpExternalResidencyGeneration = () => {
          publishedWhileHeld.push(records().length);
          return real();
        };
        lease.release();
        // Published while its own record still stood. A reader that scans once the
        // record is gone has to see the newer token, and removing first lets a scan
        // land in the gap and trust a stale map — a crash there leaves nothing for
        // anyone to reclaim.
        expect(publishedWhileHeld).toEqual([1]);
      });
    });

    it('keeps a turn hold it cannot publish instead of removing protection silently', async () => {
      await withBoard(async (dir) => {
        fs.mkdirSync(path.join(dir, 'external-turn-holds'), { recursive: true });
        const holds = new ExternalTurnHolds(dir, () => true);
        const lease = holds.claimExternalTurnHold('strata-prod', 'chat-1', 'a turn');
        holds.bumpExternalResidencyGeneration = () => false; // a filesystem it cannot write
        lease.release();
        // Other windows are left refusing rather than thrashing: a hold they can see
        // names the chat it protects, while a silent removal would let them unload
        // the model on the strength of a token that never changed.
        expect(holds.externalTurnHolders().map((hold) => hold.model)).toEqual(['strata-prod']);
      });
    });

    it('frees conservatively when a reclaim could not publish, and still loads', async () => {
      await withBoard(async (dir) => {
        const { external, unloaded } = fakeExternal([
          { name: 'strata-prod', gpus: [0, 1] },
          { name: 'strata-mid', gpus: [1] },
        ]);
        heldByOtherWindow(dir, 'strata-prod'); // a record from a host that has died
        fs.mkdirSync(path.join(dir, 'external-turn-holds', '.residency-generation'));
        // A directory where the token file belongs: neither writing it nor removing
        // it can succeed, so the reclaim of that dead record cannot publish. The
        // scan still finds no blocker and the load goes ahead — on a map this window
        // now knows it cannot prove, so every overlapping server is offered.
        const { registry, held } = lockAwareRegistry(dir, (pid) => pid !== 999999);
        const events: string[] = [];
        const recording = external as unknown as {
          reconcileForFree: () => Promise<void>;
          loadedNames: () => string[];
          unload: (name: string) => Promise<void>;
        };
        recording.loadedNames = () => [];
        recording.reconcileForFree = async () => {
          events.push(held() ? 'reconcile:inside' : 'reconcile:outside');
        };
        recording.unload = async (name: string) => {
          events.push(held() ? `unload:inside:${name}` : `unload:outside:${name}`);
          unloaded.push(name);
        };
        await prepareExternalForRequest('strata-mid', makeCtx(external, registry));
        expect(events).toEqual(['reconcile:outside', 'unload:inside:strata-prod']);
        expect(unloaded).toEqual(['strata-prod']);
        // The atomic writer retries a directory it cannot replace, so this test is
        // deliberately slower than the rest: it needs more than its 5 s default.
      });
    }, 30_000);

    it('does not trust the map when this window cannot publish its own changes', async () => {
      await withBoard(async (dir) => {
        const { external, unloaded } = fakeExternal([
          { name: 'strata-prod', gpus: [0, 1] },
          { name: 'strata-mid', gpus: [1] },
        ]);
        const { registry } = lockAwareRegistry(dir);
        registry.bumpExternalResidencyGeneration(); // a token that never changes
        const recording = external as unknown as {
          loadedNames: () => string[];
          residencyPublicationTrusted: () => boolean;
        };
        recording.loadedNames = () => [];
        // A token can only vouch for changes that reached it: with no publisher
        // wired, this window's own loads are invisible, so the token proves nothing.
        recording.residencyPublicationTrusted = () => false;
        await prepareExternalForRequest('strata-mid', makeCtx(external, registry));
        expect(unloaded).toEqual(['strata-prod']);
      });
    });

    it('reports a publication it could not make, and then answers unknown', async () => {
      await withBoard(async (dir) => {
        const holds = new ExternalTurnHolds(dir, () => true);
        fs.mkdirSync(path.join(dir, 'external-turn-holds'), { recursive: true });
        // A directory where the token file belongs: neither writing it nor removing
        // it can succeed, so the change cannot be published at all — and the answer
        // a reader gets must not be a token it would trust.
        fs.mkdirSync(path.join(dir, 'external-turn-holds', '.residency-generation'));
        expect(holds.bumpExternalResidencyGeneration()).toBe(false);
        expect(holds.externalResidencyGeneration()).toBe('');
      });
    }, 30_000);

    it('leaves a dead hold standing when its reclaim cannot be published', async () => {
      await withBoard(async (dir) => {
        heldByOtherWindow(dir, 'strata-prod'); // a record from pid 999999
        const reclaimer = new ExternalTurnHolds(dir, () => false);
        reclaimer.bumpExternalResidencyGeneration = () => false;
        expect(reclaimer.externalTurnHolders()).toEqual([]);
        // Still on disk for the next scan to try again. A dead record never blocks a
        // load, while a token that silently never changed would let every reader
        // trust a map that cannot be proved.
        expect(
          fs
            .readdirSync(path.join(dir, 'external-turn-holds'))
            .filter((name) => name.endsWith('.json')),
        ).toHaveLength(1);
      });
    });
  });
});
