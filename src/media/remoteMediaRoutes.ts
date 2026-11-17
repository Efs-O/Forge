/**
 * The five media routes on the desktop's cloud relay
 * (docs/plans/LAPTOP_REMOTE_MEDIA_PLAN.md).
 *
 * This file owns the HTTP shape and nothing else: it builds no tool, reads no
 * secret, and holds no job. `CI`-locked by `CloudRelaySurface.test.ts`, which
 * keeps it that way — the relay is the one listener a laptop can reach without
 * a token, so the code that answers it must stay free of the machinery that
 * costs money or reads a key. All of that lives behind `RemoteMediaPort`, which
 * `RemoteMediaJobs` implements.
 */
import * as http from 'http';
import type { Readable } from 'stream';
import { sendJson } from '../backend/httpJson';
import {
  REMOTE_MEDIA_ROUTES,
  REMOTE_MEDIA_TEXT,
  RemoteMediaCancelRequestSchema,
  RemoteMediaJobRequestSchema,
  type RemoteMediaCapabilities,
  type RemoteMediaJobRequest,
} from './remoteMediaContract';

export type RemoteMediaRoute = (typeof REMOTE_MEDIA_ROUTES)[number];

/** One route's answer: a JSON body, or a file to stream from the job folder. */
export type MediaReply =
  | { readonly status: number; readonly json: unknown }
  | {
      readonly status: number;
      readonly file: { readonly stream: Readable; readonly contentType: string };
    };

export function jsonReply(status: number, body: unknown): MediaReply {
  return { status, json: body };
}

/** What the routes ask the job runner for; `RemoteMediaJobs` implements it. */
export interface RemoteMediaPort {
  enabled(): boolean;
  /** A config change that turns the relay or the media block off stops the
   *  render that is running (`failed: disabled`). */
  applyConfig(): void;
  capabilities(): RemoteMediaCapabilities;
  create(request: RemoteMediaJobRequest): Promise<MediaReply>;
  status(id: string): Promise<MediaReply>;
  file(id: string, name: string): Promise<MediaReply>;
  cancel(id: string): Promise<MediaReply>;
}

export type MediaRouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: Record<string, unknown>,
) => Promise<void>;

/** A refusal the route answers itself, with the body the contract says. */
class MediaRefusal extends Error {
  constructor(readonly reply: MediaReply) {
    super('media request refused');
  }
}

function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The job body, validated by the contract's own schema. */
function jobRequest(body: Record<string, unknown>): RemoteMediaJobRequest {
  const parsed = RemoteMediaJobRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new MediaRefusal(
      jsonReply(400, {
        error: `media job request: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
      }),
    );
  }
  return parsed.data;
}

/** The job id, from the query for a GET and the body for a POST. The listener
 *  matches `"<METHOD> <path>"` exactly, so an id can never travel in the path. */
function jobId(req: http.IncomingMessage, body: Record<string, unknown>): string {
  const raw = body.id ?? new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('id') ?? '';
  const parsed = RemoteMediaCancelRequestSchema.safeParse({ id: String(raw) });
  if (!parsed.success) {
    throw new MediaRefusal(
      jsonReply(400, { error: `media job id: ${parsed.error.issues[0]?.message ?? 'invalid'}` }),
    );
  }
  return parsed.data.id;
}

/** Write the reply: JSON, or the file's bytes streamed from the job folder. */
function answer(res: http.ServerResponse, reply: MediaReply): void {
  if ('json' in reply) return sendJson(res, reply.status, reply.json);
  res.writeHead(reply.status, { 'content-type': reply.file.contentType });
  // A file that vanished between the listing and the read can only destroy the
  // reply: the status line is already on the wire.
  reply.file.stream.on('error', () => res.destroy());
  reply.file.stream.pipe(res);
}

/**
 * The five handlers, keyed by the route strings `CLOUD_RELAY_ROUTES` carries.
 *
 * With no runner wired, or `cloud_relay.media` absent or off, every one of them
 * answers 404 `{"error":"media relay is off"}` — the kill switch is the whole
 * point of the block, and the existing four relay routes are untouched.
 */
export function createMediaRoutes(
  jobs: RemoteMediaPort | undefined,
): Record<RemoteMediaRoute, MediaRouteHandler> {
  const off = (): MediaReply => jsonReply(404, { error: REMOTE_MEDIA_TEXT.off });
  const run = async (
    res: http.ServerResponse,
    work: (port: RemoteMediaPort) => MediaReply | Promise<MediaReply>,
  ): Promise<void> => {
    if (!jobs) return answer(res, off());
    try {
      answer(res, jobs.enabled() ? await work(jobs) : off());
    } catch (error) {
      answer(
        res,
        error instanceof MediaRefusal
          ? error.reply
          : jsonReply(500, { error: `media relay: ${textOf(error)}` }),
      );
    }
  };
  return {
    'GET /v1/media/capabilities': (_req, res) =>
      run(res, (port) => jsonReply(200, port.capabilities())),
    'POST /v1/media/jobs': (_req, res, body) => run(res, (port) => port.create(jobRequest(body))),
    'GET /v1/media/job': (req, res) => run(res, (port) => port.status(jobId(req, {}))),
    'GET /v1/media/file': (req, res) =>
      run(res, (port) =>
        port.file(
          jobId(req, {}),
          new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('name') ?? '',
        ),
      ),
    'POST /v1/media/cancel': (req, res, body) => run(res, (port) => port.cancel(jobId(req, body))),
  };
}
