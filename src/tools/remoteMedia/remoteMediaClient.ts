/**
 * The laptop's half of the desktop media relay
 * (docs/plans/LAPTOP_REMOTE_MEDIA_PLAN.md phase 2): the five calls the contract
 * in `src/media/remoteMediaContract.ts` defines, and nothing else.
 *
 * Three rules hold the file together, because the other end is another machine
 * that may be asleep, offline, or a Forge build without these routes:
 *
 * - **One attempt, no retry.** A job POST costs the desktop a GPU spin-up, so a
 *   transport failure is reported, never re-sent: a retry loop here could pay
 *   for the same render twice. The owner re-asks; `remoteMediaTools.ts` does not
 *   fall back to a local engine either, because a laptop has none.
 * - **A desktop that refused says so in its own words.** Any non-2xx with a JSON
 *   `error` is surfaced verbatim — the queue-full text, the not-listed
 *   approval text, `media relay is off` — so the laptop never paraphrases a
 *   policy it cannot see.
 * - **A cancelled caller is not a dead desktop.** An abort propagates unchanged;
 *   only a failure with no abort behind it is the unreachable text.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  REMOTE_MEDIA_TEXT,
  RemoteMediaCapabilitiesSchema,
  RemoteMediaJobAcceptedSchema,
  RemoteMediaJobStatusSchema,
  type RemoteMediaCapabilities,
  type RemoteMediaJobRequest,
  type RemoteMediaJobStatus,
} from '../../media/remoteMediaContract';

/** One entry of a job request's `inputs[]`, spelled from the contract rather
 *  than restated: the contract exports the schema, not the element type. */
export type RemoteMediaInput = NonNullable<RemoteMediaJobRequest['inputs']>[number];
import { sleepOrThrow } from '../../util/abortableSleep';
import { getLogger } from '../../util/logger';

const log = getLogger();

/** The poll cadence the plan fixes: 2 s for the first minute, 5 s after. A job
 *  that is still running at a minute is a video or a music render, and the
 *  laptop stops asking twice a second about one. */
export const REMOTE_MEDIA_POLL = Object.freeze({
  fastMs: 2_000,
  slowMs: 5_000,
  /** How long the fast cadence runs before it slows down. */
  windowMs: 60_000,
});

/** A capabilities answer is a metadata read: 5 s, the same deadline the model
 *  list read already uses, because it is the same machine over the same link. */
export const CAPABILITIES_TIMEOUT_MS = 5_000;
/** A job POST carries up to `max_body_bytes` of base64, so it gets a long
 *  deadline: on a slow tailnet link 24 MB is minutes, not a hung desktop. */
const SUBMIT_TIMEOUT_MS = 300_000;
/** One poll is short, so a hung desktop is caught between polls, not after the
 *  whole job. */
const POLL_TIMEOUT_MS = 10_000;
/** A rendered file is the size of a video: bounded, but not by a read timeout. */
const DOWNLOAD_TIMEOUT_MS = 600_000;
/** The cancel read: it must not be the thing that holds a cancelled call open. */
const CANCEL_TIMEOUT_MS = 10_000;

/** The desktop answered nothing at all. Its text is the whole message the
 *  laptop shows, so it is built once, here, from the contract's text. */
export class RemoteMediaUnreachableError extends Error {}

/** Every other desktop answer the laptop passes through as it stands. */
export class RemoteMediaRefusedError extends Error {}

/** The contract's route paths, spelled once. */
const ROUTES = {
  capabilities: '/v1/media/capabilities',
  jobs: '/v1/media/jobs',
  job: '/v1/media/job',
  file: '/v1/media/file',
  cancel: '/v1/media/cancel',
} as const;

interface ExchangeOptions {
  fetchImpl: typeof fetch;
  origin: string;
  method: 'GET' | 'POST';
  path: string;
  timeoutMs: number;
  signal?: AbortSignal;
  body?: unknown;
}

/** One round trip with a deadline. The deadline is its own controller so a long
 *  render is never cut by a short read, an already-cancelled caller signal cuts
 *  the request before it leaves, and the caller's abort is reported as an abort
 *  rather than as a desktop that is down — the same three rules
 *  `RemoteStarterHttp.getWithDeadline` runs by. */
async function exchange(
  options: ExchangeOptions,
): Promise<{ status: number; body: unknown; bytes: Buffer }> {
  const url = `${options.origin}${options.path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), options.timeoutMs);
  timer.unref?.();
  const forwardAbort = (): void => ctrl.abort();
  if (options.signal?.aborted) ctrl.abort();
  else options.signal?.addEventListener('abort', forwardAbort);
  try {
    const response = await options.fetchImpl(url, {
      method: options.method,
      ...(options.body === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(options.body),
          }),
      signal: ctrl.signal,
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, body: parseJson(bytes), bytes };
  } catch (error) {
    // A caller that cancelled is not a desktop that is down: that error goes up
    // unchanged. Everything else with no answer behind it — refused connection,
    // DNS, a deadline with no response — is the one text the plan fixes.
    if (options.signal?.aborted) throw error;
    throw new RemoteMediaUnreachableError(REMOTE_MEDIA_TEXT.unreachable(options.origin));
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}

function parseJson(bytes: Buffer): unknown {
  if (!bytes.length) return undefined;
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** The desktop's own refusal text, or a sentence naming the status when the body
 *  carried none. The relay's media routes answer `{"error": "…"}`; the relay's
 *  older shape is `{"error": {"message": "…"}}`, so both are read. */
function refusalText(body: unknown, status: number, route: string): string {
  const error = (body as { error?: unknown } | undefined)?.error;
  if (typeof error === 'string' && error.trim()) return error;
  const nested = (error as { message?: unknown } | undefined)?.message;
  if (typeof nested === 'string' && nested.trim()) return nested;
  return `The desktop answered HTTP ${String(status)} for ${route}.`;
}

/** Throw the shape the caller has to be ready for: unreachable, or refused with
 *  the desktop's text. */
function assertOk(reply: { status: number; body: unknown }, route: string): void {
  if (reply.status >= 200 && reply.status < 300) return;
  if (reply.status === 404 && reply.body === undefined) {
    // Not a media answer at all: a desktop from before this feature, or a
    // forwarder that answered the path itself. It reads as the off message.
    throw new RemoteMediaRefusedError(REMOTE_MEDIA_TEXT.off);
  }
  throw new RemoteMediaRefusedError(refusalText(reply.body, reply.status, route));
}

/** `GET /v1/media/capabilities` — what this desktop will render, and the
 *  definitions of its own tools. An answer that does not parse is a desktop
 *  speaking a different protocol, so it is refused rather than trusted. */
export async function fetchCapabilities(
  fetchImpl: typeof fetch,
  origin: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<RemoteMediaCapabilities> {
  const reply = await exchange({
    fetchImpl,
    origin,
    method: 'GET',
    path: ROUTES.capabilities,
    timeoutMs: options.timeoutMs ?? CAPABILITIES_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  assertOk(reply, ROUTES.capabilities);
  const parsed = RemoteMediaCapabilitiesSchema.safeParse(reply.body);
  if (!parsed.success) {
    throw new RemoteMediaRefusedError(
      'The desktop answered the media capabilities route with something Forge does not recognise: ' +
        'update Forge on the desktop.',
    );
  }
  return parsed.data;
}

/** `POST /v1/media/jobs` — the job, its arguments and any uploaded inputs, in
 *  one body. Returns the desktop's job id. */
export async function submitJob(
  fetchImpl: typeof fetch,
  origin: string,
  request: RemoteMediaJobRequest,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  const reply = await exchange({
    fetchImpl,
    origin,
    method: 'POST',
    path: ROUTES.jobs,
    timeoutMs: SUBMIT_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
    body: request,
  });
  assertOk(reply, ROUTES.jobs);
  const parsed = RemoteMediaJobAcceptedSchema.safeParse(reply.body);
  if (!parsed.success) {
    throw new RemoteMediaRefusedError(
      'The desktop accepted the job but gave no job id: update Forge on the desktop.',
    );
  }
  return parsed.data.id;
}

/** One `GET /v1/media/job?id=` read. */
export async function jobStatus(
  fetchImpl: typeof fetch,
  origin: string,
  id: string,
  options: { signal?: AbortSignal } = {},
): Promise<RemoteMediaJobStatus> {
  const reply = await exchange({
    fetchImpl,
    origin,
    method: 'GET',
    path: `${ROUTES.job}?id=${encodeURIComponent(id)}`,
    timeoutMs: POLL_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  assertOk(reply, ROUTES.job);
  const parsed = RemoteMediaJobStatusSchema.safeParse(reply.body);
  if (!parsed.success) {
    throw new RemoteMediaRefusedError(
      'The desktop answered the job status with something Forge does not recognise: update Forge ' +
        'on the desktop.',
    );
  }
  return parsed.data;
}

export interface PollOptions {
  fetchImpl: typeof fetch;
  origin: string;
  id: string;
  signal?: AbortSignal;
  /** The desktop's `progress` line, reported as it changes. */
  onProgress?: (progress: string) => void;
  /** Test seam: the wait between polls, so a test can watch a job move through
   *  several states without paying the real 2 s. */
  poll?: { fastMs?: number; slowMs?: number; windowMs?: number };
  /** Test seam for the clock the cadence is decided by. */
  now?: () => number;
}

/** Poll until the job ends, at the contract's cadence, and return its terminal
 *  status. The wait itself aborts with the caller, so a Stop costs at most one
 *  request, not a minute. */
export async function pollJob(options: PollOptions): Promise<RemoteMediaJobStatus> {
  const cadence = { ...REMOTE_MEDIA_POLL, ...(options.poll ?? {}) };
  const startedAt = (options.now ?? Date.now)();
  for (;;) {
    const status = await jobStatus(options.fetchImpl, options.origin, options.id, {
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (status.state === 'done' || status.state === 'failed') return status;
    if (status.progress) options.onProgress?.(status.progress);
    const elapsed = (options.now ?? Date.now)() - startedAt;
    await sleepOrThrow(
      elapsed < cadence.windowMs ? cadence.fastMs : cadence.slowMs,
      options.signal,
      () => new Error('cancelled'),
    );
  }
}

/** `GET /v1/media/file?id=&name=` — the bytes, streamed to `<dest>.part` and
 *  renamed once complete, so a download that dies halfway can never be read as
 *  a finished file. The `.part` is removed on failure; a `.part` a killed window
 *  left behind is overwritten by the next download of that name. */
export async function downloadFile(
  fetchImpl: typeof fetch,
  origin: string,
  id: string,
  name: string,
  destPath: string,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const reply = await exchange({
    fetchImpl,
    origin,
    method: 'GET',
    path: `${ROUTES.file}?id=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}`,
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  assertOk(reply, ROUTES.file);
  const part = `${destPath}.part`;
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  try {
    await fs.writeFile(part, reply.bytes);
    await fs.rename(part, destPath);
  } catch (error) {
    await fs.rm(part, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** `POST /v1/media/cancel` — asked once, never retried, and a failure here is
 *  logged rather than thrown: the caller has already stopped waiting, and the
 *  desktop's own TTL reclaims a job whose laptop went away. */
export async function cancelJob(
  fetchImpl: typeof fetch,
  origin: string,
  id: string,
): Promise<void> {
  try {
    await exchange({
      fetchImpl,
      origin,
      method: 'POST',
      path: ROUTES.cancel,
      timeoutMs: CANCEL_TIMEOUT_MS,
      // Deliberately not the caller's signal: that one is already aborted, and a
      // cancel dialled with an aborted signal would be a cancel never sent.
      body: { id },
    });
  } catch (error) {
    log.info(`[RemoteMedia] cancel ${id} not confirmed: ${String(error)}`);
  }
}
