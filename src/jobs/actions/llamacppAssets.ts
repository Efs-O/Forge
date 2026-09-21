import { assetMatches } from '../checks/github';

/** A release asset as the action sees it (name + digest + download URL). */
export interface ReleaseAsset {
  name: string;
  digest: string;
  downloadUrl: string;
}

/**
 * Pick the assets to download for a tag: the main build zip and its cudart
 * (both required for a CUDA build).
 *
 * The main asset is chosen by the job's `asset_pattern` (a `*`-glob on the
 * file name), not by upload order — GitHub lists assets in upload order, where
 * a `cpu-arm64` zip can come first. Among the pattern-matching `llama-<tag>-`
 * assets, the one with the highest CUDA version wins, since a pattern like
 * `llama-*-bin-win-cuda-*-x64.zip` wants the newest CUDA build. A pattern that
 * matches nothing is a misconfiguration (the check and the action would watch
 * different builds) and fails loudly.
 *
 * The cudart is the zip that pairs with the picked main build, keyed off its
 * suffix (everything after `llama-<tag>-`). Upstream has renamed it over
 * time: older builds are `cudart-llama-<tag>-<suffix>`, newer ones dropped
 * the tag, `cudart-llama-<suffix>` — both shapes are matched. A missing cudart
 * is a hard failure: a CUDA build without its cudart would extract and then
 * fail at first load, which is exactly the "config on a broken build" state
 * the post-check exists to prevent. Failing here is cheaper and earlier.
 */
export function pickAssets(
  release: { tag: string; assets: ReleaseAsset[] },
  tag: string,
  assetPattern: string,
): ReleaseAsset[] {
  const main = pickMain(release, tag, assetPattern);
  const cudart = pickCudart(release, tag, main.name);
  return [main, cudart];
}

/** The main build asset: the best `llama-<tag>-` asset matching the pattern. */
function pickMain(
  release: { tag: string; assets: ReleaseAsset[] },
  tag: string,
  assetPattern: string,
): ReleaseAsset {
  const candidates = release.assets.filter(
    (a) => a.name.startsWith(`llama-${tag}-`) && assetMatches(a.name, assetPattern),
  );
  if (candidates.length === 0) {
    throw new Error(
      `Forge: asset_pattern "${assetPattern}" matches no main asset in release ${tag} — ` +
        'the check and the action are watching different builds; fix the job',
    );
  }
  const main = candidates.reduce((best, a) =>
    cudaVersionOf(a.name) > cudaVersionOf(best.name) ? a : best,
  );
  if (!main.digest) {
    throw new Error(
      `Forge: main asset ${main.name} has no digest; refusing to install an unverifiable build`,
    );
  }
  return main;
}

/**
 * The cudart zip for a picked main build. Tries both upstream shapes, keyed
 * off the main asset's suffix (everything after `llama-<tag>-`, e.g.
 * `bin-win-cuda-13.4-x64.zip`):
 * `cudart-llama-<tag>-<suffix>` (older) and `cudart-llama-<suffix>` (current).
 */
function pickCudart(
  release: { tag: string; assets: ReleaseAsset[] },
  tag: string,
  mainName: string,
): ReleaseAsset {
  const suffix = mainName.slice(`llama-${tag}-`.length);
  const candidates = release.assets.filter(
    (a) => a.name === `cudart-llama-${tag}-${suffix}` || a.name === `cudart-llama-${suffix}`,
  );
  if (candidates.length === 0) {
    throw new Error(
      `Forge: release ${tag} is missing the cudart zip for ${mainName} ` +
        `(looked for cudart-llama-${tag}-${suffix} and cudart-llama-${suffix}); refusing a partial build`,
    );
  }
  return candidates.reduce((best, a) =>
    cudaVersionOf(a.name) > cudaVersionOf(best.name) ? a : best,
  );
}

/**
 * The CUDA version in an asset name (`-cuda-13.4-` → 13.4), or -1 for a
 * non-CUDA build. Numeric per component, so 13.4 > 12.4 (a string compare
 * would rank 9.x above 10.x).
 */
function cudaVersionOf(name: string): number {
  const m = /-cuda-(\d+)\.(\d+)(?:-|$)/.exec(name);
  if (!m) return -1;
  return Number(m[1]) * 100 + Number(m[2]);
}
