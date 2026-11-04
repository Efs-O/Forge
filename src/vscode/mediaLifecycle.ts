/**
 * The model-lifecycle seam the media tools drive.
 *
 * A render needs the GPUs it asked for, and the plan's rule is that freeing them
 * goes THROUGH Forge's own lifecycle rather than a POST to a model's port
 * (docs/plans/MEDIA_SHIPPED_PLAN.md §1 step 3): the loaded entries and their
 * busy state come from the window's `BackendPool`, and the teardown is the
 * control server's `unloadModel`, which is the path that already knows an
 * entry's `unload_path` (Strata) from a direct-spawn stop.
 */
import type { ForgeConfig } from '../config/types';
import { mergeGroupsIntoModel } from '../config/ConfigResolver';
import type { IBackendPool } from '../backend/poolTypes';
import type { ControlServer } from '../backend/ControlServer';
import type { MediaModelLifecycle, MediaLoadedModel } from '../tools/media/mediaGpuFreeing';

/**
 * The control server is wired after the tool registry, so the lifecycle holds a
 * getter and resolves it per call: a tool call can only happen once activation
 * has finished, and a reload never re-registers the tools.
 */
export function mediaLifecycleFor(
  pool: IBackendPool,
  getControlServer: () => ControlServer | undefined,
  getConfig: () => ForgeConfig,
): MediaModelLifecycle {
  return {
    loadedModels: () => {
      const config = getConfig();
      return pool.loadedModelNames().map((name) => {
        const entry = config.models.find((model) => model.name === name);
        const merged = entry ? mergeGroupsIntoModel(config, entry) : undefined;
        return {
          name,
          // `gpus` lives on the engine and reaches the entry through the resolver;
          // absent means the entry never named its cards, which `gpusOverlap`
          // treats as wanting every one of them.
          ...(merged?.gpus ? { gpus: merged.gpus } : {}),
        } satisfies MediaLoadedModel;
      });
    },
    isBusy: (modelName) => pool.isBusy(modelName),
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
