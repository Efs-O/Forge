import type { SdcppImageBackendConfig } from '../../config/types';
import { localLlamaFetch } from '../../llm/localLlamaFetch';
import type { GpuInfo } from '../../system/systemProbes';
import { withDescribedCause } from '../../util/describeError';
import { mimeFromHeader } from '../imageTool';
import { MAX_GENERATED_IMAGE_BYTES } from './cloudImageBackend';
import { alternativeText, describeHttpFailure } from './sdcppErrors';
import type { SdServerHandle, SdcppFetch } from './sdcppImageBackend';
import { assertVramAvailable } from './sdcppVramGate';

/**
 * The asynchronous `POST /sdcpp/v1/img_gen` job path — the ONLY shape measured
 * to condition a render on a reference image.
 *
 * Measured 2026-10-06 on `sd-server` build 929, RTX 3060, Qwen-Image-2.1 Q4_K:
 * - `POST /sdapi/v1/txt2img` + `ref_images`: HTTP 200, valid image, output
 *   **byte-identical** to the same-seed render with no reference. The field is
 *   silently discarded. An HTTP 200 is therefore NOT evidence of conditioning.
 * - `POST /sdapi/v1/img2img` + `init_images`: honours the init image as a
 *   **latent** starting point only. A solid magenta block as init still renders
 *   magenta at `denoising_strength: 0.75` against an apple prompt — no vision
 *   conditioning.
 * - `POST /sdcpp/v1/img_gen` + `ref_images`: server logs `Using 'qwen' preset
 *   for reference images`, and the output genuinely depends on the reference
 *   (mean pixel difference 47.7 against the same-seed no-reference render).
 *
 * So editing needs the job loop, and this module owns it: submit, poll, fetch.
 * It lives apart from `sdcppImageBackend.ts` because the loop is new state with
 * its own failure modes, and because that file is already 276 lines.
 */

/** Job contract observed on build 929. Unknown fields are tolerated, not assumed. */
interface JobSubmission {
  id?: string;
  poll_url?: string;
  status?: string;
}

interface JobStatus {
  status?: string;
  error?: string | null;
  queue_position?: number;
  result?: {
    images?: unknown;
    output_format?: string;
  };
}

export interface SdcppImageJobRequest {
  backend: SdcppImageBackendConfig;
  server: SdServerHandle;
  prompt: string;
  width: number;
  height: number;
  seed: number;
  /** Base64 PNGs from `prepareReferences`. Empty array = plain render. */
  referenceImages: readonly string[];
  alternatives: readonly string[];
  signal?: AbortSignal;
  fetchImpl?: SdcppFetch;
  /** Injectable VRAM probe for the spawn gate, as on the sync path. */
  probe?: () => Promise<GpuInfo[]>;
  /** Poll cadence override; tests use a small value, production uses the default. */
  pollIntervalMs?: number;
}

export interface SdcppJobResult {
  bytes: Buffer;
  mime: string;
  width: number;
  height: number;
  seed: number;
  /** Seconds spent in the job loop, for the timing the plan promises to log. */
  seconds: number;
  jobId: string;
}

const TERMINAL_FAILURE = new Set(['failed', 'error', 'cancelled', 'canceled']);
const SUCCESS = 'completed';

/**
 * Poll cadence. Measured: a warm 768x768 job takes 66-72 s, so a finer interval
 * buys nothing and every poll is a request through the shared local agent.
 */
export const JOB_POLL_INTERVAL_MS = 3_000;

/**
 * One submit → poll → fetch cycle.
 *
 * Timeout semantics, which the ledger demands be stated rather than inherited:
 * `request_timeout_ms` bounds **the whole job** — spawn, submit, every poll and
 * every wait between polls — not each poll. It is enforced by ONE timeout signal
 * on every request, as on the sync path: a deadline checked only between polls
 * let a hung submit or poll run on to `localLlamaFetch`'s 30-minute headers
 * timeout. The abort semantics are the shipped ones: dropping the HTTP
 * connection does not cancel a running render (`cancel_generating: false`), so
 * the caller keeps the existing rule of stopping the owned server. A job that
 * outlives the deadline is documented, not resumed — see the plan's async-job
 * ledger row.
 *
 * The whole loop — submit AND every poll — runs inside ONE `withActivity`, so
 * `activeUses` stays above zero for the life of the job. That is not cosmetic:
 * a warm edit measured 174–606 s and `idle_timeout_ms` defaults to 600 s, so a
 * poll loop that sat outside that guard would let the idle timer stop Forge's own
 * server **mid-render**, killing the job. An adopter touches the owner record
 * only when the activity starts and ends; that is enough only because the job
 * is bounded by `request_timeout_ms` and the schema makes `idle_timeout_ms`
 * exceed it by a minute, so the owner's shared deadline cannot pass mid-job.
 * Remove the timeout signal and that guarantee goes with it.
 */
export async function runSdcppImageJob(request: SdcppImageJobRequest): Promise<SdcppJobResult> {
  const { backend, server } = request;
  const fetchImpl: SdcppFetch = request.fetchImpl ?? localLlamaFetch;
  const endpoint = '/sdcpp/v1/img_gen';
  const startedAt = Date.now();
  const turnSignal = request.signal;
  const timeoutSignal = AbortSignal.timeout(backend.request_timeout_ms);
  const signal = turnSignal ? AbortSignal.any([turnSignal, timeoutSignal]) : timeoutSignal;
  // Out here so the timeout sentence can say how far the job got.
  let jobId = 'not yet submitted';
  let last: JobStatus | undefined;

  try {
    await server.withActivity(
      async () => {
        const response = await fetchImpl(`${server.baseUrl()}${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: request.prompt,
            negative_prompt: '',
            width: request.width,
            height: request.height,
            steps: backend.defaults.steps,
            cfg_scale: backend.defaults.cfg_scale,
            seed: request.seed,
            ...(request.referenceImages.length > 0
              ? { ref_images: [...request.referenceImages] }
              : {}),
          }),
          signal,
        });
        if (response.status !== 202) {
          throw new Error(
            await describeHttpFailure(backend, response, request.alternatives, endpoint),
          );
        }
        const submission = (await response.json()) as JobSubmission;
        const pollPath = submission.poll_url;
        jobId = submission.id ?? pollPath ?? 'unknown';
        if (!pollPath) {
          throw new Error(
            `${backend.name}: sd-server accepted ${endpoint} with 202 but returned no poll_url, so ` +
              `Forge cannot follow the job (it was ${jobId}). Check the "Forge - image server" ` +
              `output channel, or use ${alternativeText(request.alternatives)}.`,
          );
        }

        const pollIntervalMs = request.pollIntervalMs ?? JOB_POLL_INTERVAL_MS;
        for (;;) {
          await sleep(pollIntervalMs, signal);
          signal.throwIfAborted();
          const polled = await fetchImpl(`${server.baseUrl()}${pollPath}`, {
            method: 'GET',
            signal,
          });
          if (!polled.ok) {
            throw new Error(
              await describeHttpFailure(backend, polled, request.alternatives, pollPath),
            );
          }
          const status = (await polled.json()) as JobStatus;
          last = status;
          const state = String(status.status ?? '').toLowerCase();
          if (TERMINAL_FAILURE.has(state)) {
            throw new Error(
              `${backend.name}: the ${endpoint} job ${jobId} ${state}` +
                `${status.error ? `: ${String(status.error).slice(0, 400)}` : ''}. See the ` +
                `"Forge - image server" output channel, or use ` +
                `${alternativeText(request.alternatives)}.`,
            );
          }
          if (state === SUCCESS || status.result) return;
        }
      },
      // The VRAM gate belongs to the spawn, exactly as on the sync path: models
      // load lazily, so gating a spawn gates the first request, and gating an
      // adopter would refuse the VRAM the other window's owned server already
      // holds.
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
    // Outside the activity, as on the sync path, so a cancel during spawn,
    // submit, a wait or a poll all reach the same stop rule.
    if (turnSignal?.aborted) throw await abortAndDescribe(request, error);
    if (timeoutSignal.aborted) throw jobTimeoutError(request, endpoint, jobId, last);
    throw withDescribedCause(error);
  }
  // Unreachable unless the loop returned without a status; kept so `last` narrows.
  if (!last) throw jobTimeoutError(request, endpoint, jobId, last);

  const encoded = firstImageBase64(last.result?.images);
  if (!encoded) {
    throw new Error(
      `${backend.name}: sd-server reported job ${jobId} complete but put no image in ` +
        `result.images[0]. Check the "Forge - image server" output channel, or use ` +
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
  return {
    bytes,
    mime,
    width: request.width,
    height: request.height,
    seed: request.seed,
    seconds: (Date.now() - startedAt) / 1000,
    jobId,
  };
}

/** `result.images` is `[{ b64_json, index }]` on build 929; tolerate a bare string. */
export function firstImageBase64(images: unknown): string | undefined {
  if (!Array.isArray(images) || images.length === 0) return undefined;
  const first = images[0];
  if (typeof first === 'string') return first || undefined;
  if (first && typeof first === 'object') {
    const record = first as Record<string, unknown>;
    const value = record['b64_json'] ?? record['base64'];
    return typeof value === 'string' && value ? value : undefined;
  }
  return undefined;
}

/**
 * The shipped abort rule, identical to the sync path (A12): dropping the HTTP
 * connection does not cancel a render, so the owned server has to be stopped —
 * and only under the `lastUsedAt` rule, which `stopAfterAbort()` owns. The
 * sentence it returns is reported so the user knows whether the card is free.
 */
async function abortAndDescribe(request: SdcppImageJobRequest, cause: unknown): Promise<Error> {
  try {
    const note = await request.server.stopAfterAbort();
    return new Error(
      `${request.backend.name}: the turn was cancelled while ` +
        `${request.prompt.slice(0, 60) || 'a render'} was rendering. ${note}`,
      { cause },
    );
  } catch (cleanupError) {
    return new AggregateError(
      [cause, cleanupError],
      `generate_image: ${request.backend.name} render was cancelled and stopping the server failed too.`,
    );
  }
}

/** A16 is deferred: the job is not cancelled, so the sentence must say it may still hold the GPU. */
function jobTimeoutError(
  request: SdcppImageJobRequest,
  endpoint: string,
  jobId: string,
  last: JobStatus | undefined,
): Error {
  const { backend } = request;
  return new Error(
    `${backend.name}: the ${endpoint} job ${jobId} did not finish within request_timeout_ms ` +
      `(${backend.request_timeout_ms.toLocaleString()} ms); its last state was ` +
      `"${last?.status ?? 'unknown'}". The job may still be running on the GPU, so a second ` +
      `request can queue behind it — retry later, ask for a smaller size, or use ` +
      `${alternativeText(request.alternatives)}.`,
  );
}

/**
 * Interruptible sleep. A turn abort has to land during the wait, not only
 * between polls, or cancelling a 70 s render feels dead for up to the poll
 * interval.
 */
async function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
