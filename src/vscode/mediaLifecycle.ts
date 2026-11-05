/**
 * The model-lifecycle seam the media tools drive.
 *
 * A render needs the GPUs it asked for, and the plan's rule is that freeing them
 * goes THROUGH Forge's own lifecycle rather than a POST to a model's port
 * (docs/plans/MEDIA_SHIPPED_PLAN.md §1 step 3): the loaded entries and their
 * busy state come from the window's `BackendPool`, and the teardown is the
 * control server's `unloadModel`, which is the path that already knows an
 * entry's `unload_path` (Strata) from a direct-spawn stop.
 *
 * The pool's `loadedModelNames()` is the slot table, so it never names a managed
 * external server: a render that wants a card Strata occupies used to see no
 * overlap at all, refuse on the VRAM gate, and tell the agent to use another
 * engine or a card that is free (BL-031). The managed externals are therefore
 * listed here beside the slots, and their busy answer includes the machine-wide
 * managed turn holds — `pool.isBusy` covers this window's pins only, and
 * unloading a server another window is streaming on is the BL-023 and BL-025
 * cut-off this seam must not reopen.
 */
import type { ForgeConfig } from '../config/types';
import { mergeGroupsIntoModel } from '../config/ConfigResolver';
import { gpusOverlap } from '../backend/poolAcquisition';
import type { IBackendPool } from '../backend/poolTypes';
import type { ControlServer } from '../backend/ControlServer';
import type { ExternalModelServers } from '../backend/ExternalModelServers';
import type { ExternalTurnHold } from '../backend/SharedRuntimeRegistry';
import type { MediaModelLifecycle, MediaLoadedModel } from '../tools/media/mediaGpuFreeing';

/** What the lifecycle needs about managed externals, read per call. */
export interface MediaExternals {
  /** The window's managed externals (Strata); undefined when none are configured. */
  servers: ExternalModelServers | undefined;
  /** Live machine-wide managed turn holds, from the shared runtime registry. */
  holds: readonly ExternalTurnHold[];
}

/**
 * The control server is wired after the tool registry, so the lifecycle holds a
 * getter and resolves it per call: a tool call can only happen once activation
 * has finished, and a reload never re-registers the tools.
 */
export function mediaLifecycleFor(
  pool: IBackendPool,
  getControlServer: () => ControlServer | undefined,
  getConfig: () => ForgeConfig,
  getExternals?: () => MediaExternals,
): MediaModelLifecycle {
  /**
   * The cards an entry wants, from the one place both kinds of entry get them:
   * the config entry through the resolver, which is what the slot table and
   * `gpusOverlap` already use, with the managed engine's answer beside it.
   * Absent means the entry never named its cards, which means it wants all of
   * them — the same fail-closed rule the rest of the pool applies.
   */
  const gpusFor = (name: string): readonly number[] | undefined => {
    const config = getConfig();
    const entry = config.models.find((model) => model.name === name);
    const merged = entry ? mergeGroupsIntoModel(config, entry) : undefined;
    return merged?.gpus ?? getExternals?.()?.servers?.gpusOf(name);
  };
  return {
    loadedModels: () => {
      const local = pool.loadedModelNames().map((name) => {
        const gpus = gpusFor(name);
        return {
          name,
          // `gpus` lives on the engine and reaches the entry through the resolver;
          // absent means the entry never named its cards, which `gpusOverlap`
          // treats as wanting every one of them.
          ...(gpus ? { gpus } : {}),
        } satisfies MediaLoadedModel;
      });
      const externals = getExternals?.();
      const servers = externals?.servers;
      if (!servers) return local;
      // A live turn hold means the server is loaded, whatever this window's
      // residency map remembers: leaving it out would hide a server another
      // window is streaming on from the overlap check, and freeing the card
      // under it is the BL-025 cut-off through a different door.
      const names = new Set([...servers.loadedNames(), ...externals.holds.map((h) => h.model)]);
      const seen = new Set(local.map((entry) => entry.name));
      const external = [...names]
        .filter((name) => !seen.has(name))
        .map((name) => {
          // `ExternalModelServers.gpusOf` is the answer the rest of the pool gives
          // for a managed entry; absent means its entry named no cards, which
          // `gpusOverlap` reads as wanting all of them — unloading, never sharing.
          const gpus = servers.gpusOf(name);
          return { name, ...(gpus ? { gpus } : {}) } satisfies MediaLoadedModel;
        });
      return [...local, ...external];
    },
    isBusy: (modelName, ownConversationId) => {
      if (pool.isBusy(modelName)) return true;
      const externals = getExternals?.();
      if (!externals) return false;
      // Holds are published without a profile suffix, and a hold in another
      // window is not in this one's pins. An alias resolving to a held base
      // blocks conservatively: the render waits, nobody's turn is cut off.
      const base = modelName.split('@')[0];
      const cards = gpusFor(base);
      return externals.holds.some((hold) => {
        // The calling chat's own turn hold is not a conflict. A chat on Strata
        // holds that server for its whole turn and then asks for a render on the
        // same cards: counting its own hold would wait out 120 s and refuse the
        // render it was asked for. Same pid AND same conversation — a hold from
        // another window, or from another chat in this one, still blocks.
        if (
          ownConversationId !== undefined &&
          hold.pid === process.pid &&
          hold.conversationId === ownConversationId
        ) {
          return false;
        }
        if (hold.model === base) return true;
        // Holds conflict by CARD, not by name — the same rule
        // `SharedRuntimeRegistry.ts:227` uses when it refuses a turn hold, and
        // the same `gpusOverlap` the freeing path uses. An entry that named no
        // cards overlaps every card, so an unknown answer never shares one.
        return gpusOverlap(gpusFor(hold.model), cards);
      });
    },
    unloadModel: async (modelName) => {
      const controlServer = getControlServer();
      if (!controlServer) {
        return {
          unloaded: false,
          error:
            'no model control server in this window, so the entry cannot be unloaded ' +
            'through Forge\u2019s lifecycle.',
        };
      }
      const result = await controlServer.unloadModel(modelName);
      if (result.status === 200 && 'unloaded' in result.body) {
        return { unloaded: result.body.unloaded === true };
      }
      const error =
        'error' in result.body && typeof result.body.error === 'string'
          ? result.body.error
          : `the model control server answered ${result.status}`;
      return { unloaded: false, error };
    },
  };
}
