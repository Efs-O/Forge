/**
 * The still a text-to-video request needs, from the configured image backend.
 *
 * `media.video.still_backend` names an `image_generation.backends[]` entry, and
 * the render goes through `generateImageToolLocal.renderLocalVariation` — the
 * same local sd-server path `generate_image` uses, with its VRAM gate, its
 * `beforeSpawn` position and its owner-record teardown — rather than a second
 * SD client. The still lands in the run folder's `input/`, so the run keeps
 * every byte that produced the clip (docs/plans/MEDIA_SHIPPED_PLAN.md §2 and
 * the ledger row for the run folder).
 */
import * as path from 'path';
import { writeFileAtomic } from '../../util/atomicWrite';
import { EXTENSION_BY_MIME } from '../imageGeneration/generateImageToolFormat';
import { renderLocalVariation } from '../imageGeneration/generateImageToolLocal';

const EXT = '.png';

export interface MediaStillRequest {
  prompt: string;
  /** The shape whose configured resolution the sd-server renders at. */
  sizeName: 'square' | 'portrait' | 'landscape';
  seed: number;
  /** `<run>/input`; the adapter stages the file into ComfyUI's own input folder. */
  outDir: string;
}

export interface MediaStillDeps {
  backend: Parameters<typeof renderLocalVariation>[0]['backend'];
  server: Parameters<typeof renderLocalVariation>[0]['server'];
  /** The other configured backends, named in every refusal. */
  alternatives: readonly string[];
  /** Injectable: the sd-server call itself, so a unit test needs no port or GPU. */
  renderLocal?: typeof renderLocalVariation;
  signal?: AbortSignal;
}

/** The aspect the clip will have, so the still is not cropped by the engine. */
export function stillSizeName(size: {
  width: number;
  height: number;
}): MediaStillRequest['sizeName'] {
  if (size.width > size.height) return 'landscape';
  if (size.height > size.width) return 'portrait';
  return 'square';
}

/**
 * One still, written before the video engine takes the GPU: the sd-server
 * takes and releases the same media GPU lease itself (`SdServerBackend` when
 * `media_gpu_lease_enabled`), so holding the lease across both would make the
 * still refuse its own server.
 */
export async function renderMediaStill(
  req: MediaStillRequest,
  deps: MediaStillDeps,
): Promise<{ path: string; seed: number; width: number; height: number }> {
  const variation = await (deps.renderLocal ?? renderLocalVariation)({
    backend: deps.backend,
    server: deps.server,
    prompt: req.prompt,
    size: req.sizeName,
    seed: req.seed,
    alternatives: deps.alternatives,
    deps: {},
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  const extension = EXTENSION_BY_MIME[variation.mime] ?? EXT;
  const target = path.join(req.outDir, `still${extension}`);
  await writeFileAtomic(target, variation.bytes);
  return {
    path: target,
    seed: variation.seed,
    width: variation.width,
    height: variation.height,
  };
}
