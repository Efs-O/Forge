import * as http from 'http';
import { Readable, Writable } from 'stream';
import { describe, expect, it, vi } from 'vitest';
import { REMOTE_MEDIA_TEXT } from '../../src/media/remoteMediaContract';
import { createMediaRoutes, type MediaReply, type RemoteMediaPort } from '../../src/media/remoteMediaRoutes';

/**
 * The five media routes, with the job runner faked: this file is the relay's
 * own surface, so what is under test is the HTTP shape — the media-off answer,
 * the id and name read out of the query string, and a listed file streamed.
 * The decisions behind them (approval, paths, the queue) are
 * `RemoteMediaJobs.test.ts`.
 */

/** A response that collects what the routes write, and settles on `finish`. */
class Capture extends Writable {
  status = 0;
  headers: Record<string, string> = {};
  private readonly bytes: Buffer[] = [];
  private settle!: () => void;
  readonly settled = new Promise<void>((resolve) => (this.settle = resolve));

  constructor() {
    super();
    this.once('finish', () => this.settle());
  }

  writeHead(status: number, headers: Record<string, string>): this {
    this.status = status;
    this.headers = { ...headers };
    return this;
  }

  override _write(chunk: Buffer, _encoding: string, callback: () => void): void {
    this.bytes.push(Buffer.from(chunk));
    callback();
  }

  asResponse(): http.ServerResponse {
    return this as unknown as http.ServerResponse;
  }

  text(): string {
    return Buffer.concat(this.bytes).toString('utf8');
  }

  buffer(): Buffer {
    return Buffer.concat(this.bytes);
  }
}

function request(url = '/'): http.IncomingMessage {
  return { url } as http.IncomingMessage;
}

const ID = 'abcdef12-3456';

function port(overrides: Partial<RemoteMediaPort> = {}): RemoteMediaPort {
  return {
    enabled: () => true,
    applyConfig: () => undefined,
    capabilities: () => ({ tools: [], upscale: false, refused: [], max_body_bytes: 1024 }),
    create: vi.fn(async (): Promise<MediaReply> => ({ status: 202, json: { id: ID } })),
    status: vi.fn(async (): Promise<MediaReply> => ({ status: 200, json: { id: ID, state: 'done' } })),
    file: vi.fn(async (): Promise<MediaReply> => ({
      status: 404,
      json: { error: `job ${ID} has no finished file missing.png` },
    })),
    cancel: vi.fn(async (): Promise<MediaReply> => ({ status: 200, json: { state: 'failed' } })),
    ...overrides,
  };
}

async function call(
  route: 'GET /v1/media/capabilities' | 'POST /v1/media/jobs' | 'GET /v1/media/job' | 'GET /v1/media/file' | 'POST /v1/media/cancel',
  jobs: RemoteMediaPort | undefined,
  url = '/',
  body: Record<string, unknown> = {},
): Promise<Capture> {
  const res = new Capture();
  await createMediaRoutes(jobs)[route](request(url), res.asResponse(), body);
  await res.settled;
  return res;
}

describe('remote media routes', () => {
  it('answers the media-off body on every route with no runner wired', async () => {
    for (const route of [
      'GET /v1/media/capabilities',
      'POST /v1/media/jobs',
      'GET /v1/media/job',
      'GET /v1/media/file',
      'POST /v1/media/cancel',
    ] as const) {
      const res = await call(route, undefined);
      expect(res.status).toBe(404);
      expect(res.text()).toBe(`{"error":"${REMOTE_MEDIA_TEXT.off}"}`);
    }
  });

  it('answers the same 404 when the media block is off', async () => {
    const res = await call('GET /v1/media/capabilities', port({ enabled: () => false }));
    expect(res.status).toBe(404);
    expect(res.text()).toBe(`{"error":"${REMOTE_MEDIA_TEXT.off}"}`);
  });

  it('reads the job id and file name from the query string, never the path', async () => {
    const jobs = port();
    const status = await call('GET /v1/media/job', jobs, `/v1/media/job?id=${ID}`);
    expect(status.status).toBe(200);
    expect(jobs.status).toHaveBeenCalledWith(ID);

    const file = await call('GET /v1/media/file', jobs, `/v1/media/file?id=${ID}&name=cat.png`);
    expect(file.status).toBe(404);
    expect(jobs.file).toHaveBeenCalledWith(ID, 'cat.png');

    const cancel = await call('POST /v1/media/cancel', jobs, '/v1/media/cancel', { id: ID });
    expect(cancel.status).toBe(200);
    expect(jobs.cancel).toHaveBeenCalledWith(ID);
  });

  it('refuses an id that is not a job id, and a body the contract rejects', async () => {
    const jobs = port();
    const bad = await call('GET /v1/media/job', jobs, '/v1/media/job?id=../../policy.yaml');
    expect(bad.status).toBe(400);
    expect(jobs.status).not.toHaveBeenCalled();

    const badBody = await call('POST /v1/media/jobs', jobs, '/v1/media/jobs', {
      tool: 'generate_image',
      client: 'laptop',
      extra: 'not in the contract',
    });
    expect(badBody.status).toBe(400);
    expect(jobs.create).not.toHaveBeenCalled();
  });

  it('streams a listed file, and 404s a name the job did not list', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const listed = await call(
      'GET /v1/media/file',
      port({
        file: async () => ({
          status: 200,
          file: { stream: Readable.from([bytes]), contentType: 'image/png' },
        }),
      }),
      `/v1/media/file?id=${ID}&name=cat.png`,
    );
    expect(listed.status).toBe(200);
    expect(listed.headers['content-type']).toBe('image/png');
    expect(listed.buffer().equals(bytes)).toBe(true);

    const unlisted = await call(
      'GET /v1/media/file',
      port(),
      `/v1/media/file?id=${ID}&name=missing.png`,
    );
    expect(unlisted.status).toBe(404);
    expect(JSON.parse(unlisted.text())).toEqual({
      error: `job ${ID} has no finished file missing.png`,
    });
  });

  it('answers 500 with the reason when the runner throws', async () => {
    const res = await call(
      'GET /v1/media/capabilities',
      port({
        capabilities: () => {
          throw new Error('boom');
        },
      }),
    );
    expect(res.status).toBe(500);
    expect(JSON.parse(res.text())).toEqual({ error: 'media relay: boom' });
  });
});
