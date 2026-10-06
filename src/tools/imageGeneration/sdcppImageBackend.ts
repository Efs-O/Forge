import type { SdcppImageBackendConfig } from '../../config/types';
import { localLlamaFetch } from '../../llm/localLlamaFetch';
import type { GpuInfo } from '../../system/systemProbes';
import { withDescribedCause } from '../../util/describeError';
import { mimeFromHeader } from '../imageTool';
import { MAX_GENERATED_IMAGE_BYTES, type GeneratedImage } from './cloudImageBackend';
import { alternativeText, describeHttpFailure } from './sdcppErrors';
import { assertVramAvailable } from './sdcppVramGate';

/**
 * The `size` argument: Qwen-Image's native training resolutions (about 1.7 MP). Owned here so the tool's enum and
 * the request's pixel dimensions cannot drift apart.
 */
export const SDCPP_SIZES = {
  square: { width: 1328, height: 1328 },
  portrait: { width: 928, height: 1664 },
  landscape: { width: 1664, height: 928 },
} as const;

export type SdcppSizeName = keyof typeof SDCPP_SIZES;
export const SDCPP_SIZE_NAMES: readonly SdcppSizeName[] = ['square', 'portrait', 'landscape'];

export interface SdSizeShape {
  width: number;
  height: number;
}

export function sdcppSizeFor(name: unknown, config: SdcppImageBackendConfig): SdSizeShape {
  if (typeof name !== 'string' || !name) {
    return { width: config.defaults.width, height: config.defaults.height };
  }
  const chosen = (SDCPP_SIZES as Record<string, SdSizeShape | undefined>)[name];
  if (!chosen) {
    throw new Error(
      `generate_image: size "${name}" is not one of ${SDCPP_SIZE_NAMES.join(', ')}. ` +
        'Omit it to use the configured defaults.',
    );
  }
  return chosen;
}

/**
 * The part of `SdServerBackend` this module needs, as a contract: the backend
 * stays the only owner of the process, and the gate, the request and the abort
 * rule stay testable without a process, a GPU or a port.
 */
export interface SdServerHandle {
  baseUrl(): string;
  withActivity<T>(
    operation: () => Promise<T>,
    options?: { beforeSpawn?: () => Promise<void> },
  ): Promise<T>;
  /** The plan's abort rule; returns the sentence the tool reports back. */
  stopAfterAbort(): Promise<string>;
}

export interface SdcppImageRequest {
  backend: SdcppImageBackendConfig;
  server: SdServerHandle;
  prompt: string;
  size?: unknown;
  /** The other configured backends, named in every refusal (refusals name the alternative). */
  alternatives: readonly string[];
  signal?: AbortSignal;
  /** Injectable: the real probe spawns nvidia-smi. */
  probe?: () => Promise<GpuInfo[]>;
  fetchImpl?: SdcppFetch;
  /** Injectable: the real seed is random, so a rerender is not a byte copy. */
  seed?: () => number;
}

export type SdcppGeneratedImage = GeneratedImage & {
  seed: number;
  width: number;
  height: number;
};

/**
 * The transport this module needs. `typeof fetch` satisfies it (the call site
 * always passes `init`), and `localLlamaFetch` does too, which is the point:
 * the default must be the raised-timeout local fetch, not the global one.
 */
export type SdcppFetch = (url: string, init: RequestInit) => Promise<Response>;

interface Txt2ImgResponse {
  images?: unknown;
}

/**
 * One image from the local `sd-server`, over `POST /sdapi/v1/txt2img` — the
 * endpoint Phase 0b chose because it honours `seed`, `width`/`height`, `steps`
 * and `cfg_scale` (the OpenAI-shaped endpoint ignored the seed and used cfg 7).
 *
 * The VRAM gate is handed to `withActivity` as `beforeSpawn`, which the backend
 * runs only when this call is about to spawn its own server, after any orphan
 * reaping. That is the gate's one correct position: models load lazily (0b: 0 MB
 * until the first render), so gating a spawn gates the first request; gating an
 * adopter would refuse the very VRAM the other window's owned server is already
 * holding, and gating after the spawn would let an over-budget model load first.
 */
export async function generateSdcppImage(request: SdcppImageRequest): Promise<SdcppGeneratedImage> {
  const { backend, server } = request;
  // The default is `localLlamaFetch`, not global `fetch`. `sd-server` sends no
  // response headers until the render finishes — the same shape llama.cpp has —
  // so a cold first render (lazy weights plus a CPU-resident text encoder) sits
  // past undici's default 300 s headers timeout and dies as a bare
  // `fetch failed: Headers Timeout Error`. That transport limit has no knob on
  // global fetch; the shared local Agent raises it to 30 min, which stays above
  // `request_timeout_ms`, so the request's own deadline below remains the one
  // that decides when a render is given up on.
  const fetchImpl: SdcppFetch = request.fetchImpl ?? localLlamaFetch;
  const { width, height } = sdcppSizeFor(request.size, backend);
  const seed = request.seed?.() ?? randomSeed();
  const turnSignal = request.signal;
  const timeoutSignal = AbortSignal.timeout(backend.request_timeout_ms);
  const signal = turnSignal ? AbortSignal.any([turnSignal, timeoutSignal]) : timeoutSignal;

  let body: Txt2ImgResponse;
  try {
    body = await server.withActivity(
      async () => {
        const response = await fetchImpl(`${server.baseUrl()}/sdapi/v1/txt2img`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: request.prompt,
            negative_prompt: '',
            width,
            height,
            steps: backend.defaults.steps,
            cfg_scale: backend.defaults.cfg_scale,
            seed,
            batch_size: 1,
          }),
          signal,
        });
        if (!response.ok) {
          throw new Error(
            await describeHttpFailure(backend, response, request.alternatives, '/sdapi/v1/txt2img'),
          );
        }
        return (await response.json()) as Txt2ImgResponse;
      },
      {
        beforeSpawn: () =>
          assertVramAvailable({
            backend,
            alternatives: request.alternatives,
            ...(request.probe ? { probe: request.probe } : {}),
          }),
      },
    );
  } catch (error) {
    if (turnSignal?.aborted) {
      const note = await abortAndDescribe(request, error);
      throw new Error(
        `${backend.name}: the turn was cancelled while ${request.prompt.slice(0, 60) || 'a render'} ` +
          `was rendering. ${note}`,
      );
    }
    if (timeoutSignal.aborted) {
      throw new Error(
        `${backend.name}: the render exceeded request_timeout_ms ` +
          `(${backend.request_timeout_ms.toLocaleString()} ms). A second request waits behind the one ` +
          `already rendering, so retry later, ask for a smaller size, or use ` +
          `${alternativeText(request.alternatives)}.`,
      );
    }
    // A transport fault (refused port, reset socket, headers timeout) reaches
    // here as `TypeError: fetch failed`, whose only distinguishing detail lives
    // in `cause`. Rebuild it with the chain in the message so the tool result
    // names the fault instead of collapsing it into four words.
    throw withDescribedCause(error);
  }

  const encoded = Array.isArray(body.images) ? body.images[0] : undefined;
  if (typeof encoded !== 'string' || !encoded) {
    throw new Error(
      `${backend.name}: sd-server answered 200 for /sdapi/v1/txt2img but put no image in images[0]. ` +
        `Check the "Forge - image server" output channel, or use ` +
        `${alternativeText(request.alternatives)}.`,
    );
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > MAX_GENERATED_IMAGE_BYTES) {
    throw new Error(
      `${backend.name}: image is ${bytes.length.toLocaleString()} bytes, over the cap.`,
    );
  }
  const mime = mimeFromHeader(bytes);
  if (!mime) {
    throw new Error(
      `${backend.name}: sd-server returned data that is not a PNG, JPEG, GIF, BMP or WebP image.`,
    );
  }
  return { bytes, mime, seed, width, height };
}

/**
 * The shipped abort rule (A12): dropping the HTTP connection does not cancel a
 * render, so `stopAfterAbort()` decides whether the owned server is stopped and
 * returns the sentence the user sees. A failed stop is reported with the cause.
 */
async function abortAndDescribe(request: SdcppImageRequest, cause: unknown): Promise<string> {
  try {
    return await request.server.stopAfterAbort();
  } catch (cleanupError) {
    throw new AggregateError(
      [cause, cleanupError],
      `generate_image: ${request.backend.name} render was cancelled and stopping the server failed too.`,
    );
  }
}

function randomSeed(): number {
  return Math.floor(Math.random() * 2_147_483_647);
}
