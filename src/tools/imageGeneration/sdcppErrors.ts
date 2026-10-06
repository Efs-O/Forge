import type { ImageBackendConfig } from '../../config/types';

/**
 * The refusal voice shared by both `sd-server` request shapes (the synchronous
 * `/sdapi/v1/txt2img` render and the asynchronous `/sdcpp/v1/img_gen` job).
 * Owned here so the two paths cannot drift into two different explanations of
 * the same failure, and so neither has to import the other.
 */

export const MAX_ERROR_BODY_CHARS = 400;

export function alternativeText(alternatives: readonly string[]): string {
  return alternatives.length ? `backend ${alternatives.join(' or ')}` : 'a cloud image backend';
}

/** Turn a non-2xx `sd-server` answer into a sentence that names the fix. */
export async function describeHttpFailure(
  backend: ImageBackendConfig & { provider: 'sdcpp' },
  response: Response,
  alternatives: readonly string[],
  endpoint: string,
): Promise<string> {
  const detail = (await response.text()).slice(0, MAX_ERROR_BODY_CHARS).trim();
  if (/out of memory|\bOOM\b|cannot allocate|allocation failed/i.test(detail)) {
    return (
      `${backend.name}: out of memory on GPU ${backend.cuda_device} — something else is using it ` +
      `(whisper, a mmproj); retry, or use ${alternativeText(alternatives)}.` +
      `${detail ? ` The server said: ${detail}` : ''}`
    );
  }
  return (
    `${backend.name}: sd-server returned HTTP ${response.status} for ${endpoint}` +
    `${detail ? `: ${detail}` : ''}. See the "Forge - image server" output channel, or use ` +
    `${alternativeText(alternatives)}.`
  );
}

/**
 * The sentence used when a request that carried reference images cannot be
 * honoured by this backend. FORGE.md rule: a refusal names the alternative.
 */
export function referenceRefusal(
  backend: ImageBackendConfig & { provider: 'sdcpp' },
  alternatives: readonly string[],
): string {
  return (
    `${backend.name}: reference images need ` +
    `image_generation.backends.${backend.name}.vision_encoder. Point it at the vision tower ` +
    `(an mmproj-*.gguf matching ${backend.text_encoder}), or use ` +
    `${alternativeText(alternatives)}.`
  );
}
