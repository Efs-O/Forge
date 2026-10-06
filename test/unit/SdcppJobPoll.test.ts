import { describe, expect, it, vi } from 'vitest';
import type { SdcppImageBackendConfig } from '../../src/config/types';
import { ImageGenerationConfigSchema } from '../../src/config/imageGenerationSchema';
import type { GpuInfo } from '../../src/system/systemProbes';
import type { SdServerHandle, SdcppFetch } from '../../src/tools/imageGeneration/sdcppImageBackend';
import {
  firstImageBase64,
  runSdcppImageJob,
  type SdcppJobRequest,
} from '../../src/tools/imageGeneration/sdcppJobPoll';

/**
 * The async job path — the ONLY shape measured to condition a render on a
 * reference. Tested against the job contract captured on 2026-10-06 from
 * `sd-server` build 929: `202 {id, poll_url}` then
 * `{status, queue_position, result:{images:[{b64_json,index}], output_format}}`.
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sdcppConfig(overrides: Record<string, unknown> = {}): SdcppImageBackendConfig {
  const parsed = ImageGenerationConfigSchema.parse({
    backends: [
      {
        name: 'qwen-local',
        provider: 'sdcpp',
        binary: 'V:/Tools/sd.cpp/sd-server.exe',
        diffusion_model: 'V:/models/Qwen-Image-2.1/qwen_image_2.1-Q4_K.gguf',
        text_encoder: 'V:/models/Qwen-Image-2.1/Qwen3VL-8B-Instruct-Q4_K_M.gguf',
        vae: 'V:/models/Qwen-Image-2.1/qwen_image_2.1_vae_bf16.safetensors',
        cuda_device: 2,
        text_encoder_on_cpu: true,
        port: 8093,
        min_free_vram_mb: 7000,
        idle_timeout_ms: 600_000,
        request_timeout_ms: 300_000,
        defaults: { steps: 20, cfg_scale: 6, sampler: 'euler', width: 1024, height: 1024 },
        extra_args: [],
        confirm_on_start: true,
        confirm_each: false,
        vision_encoder: 'V:/models/Qwen-Image-2.1/mmproj-Qwen3VL-8B-Instruct-F16.gguf',
        ...overrides,
      },
    ],
  });
  const backend = parsed.backends[0];
  if (!backend || backend.provider !== 'sdcpp') throw new Error('config did not parse as sdcpp.');
  return backend;
}

function gpu(usedMb: number | null, totalMb: number | null = 12288): GpuInfo {
  return {
    index: 2,
    name: 'RTX 3060',
    memoryUsedMb: usedMb,
    memoryTotalMb: totalMb,
    utilizationPercent: 0,
    temperatureC: 40,
  };
}

function fakeServer(options: { spawnNeeded?: boolean } = {}) {
  let stopCalls = 0;
  let activeUses = 0;
  const handle: SdServerHandle = {
    baseUrl: () => 'http://127.0.0.1:8093',
    withActivity: async (operation, startOptions) => {
      if (startOptions?.beforeSpawn && options.spawnNeeded !== false) {
        await startOptions.beforeSpawn();
      }
      activeUses++;
      try {
        return await operation();
      } finally {
        activeUses--;
      }
    },
    stopAfterAbort: async () => {
      stopCalls++;
      return 'Forge stopped its own sd-server, the only way to cancel a render, so the card is free again.';
    },
  };
  return { handle, stopCalls: () => stopCalls, activeUses: () => activeUses };
}

interface JobAnswer {
  submit?: { status: number; body: unknown };
  polls?: { status: number; body: unknown }[];
}

function fetchFor(answers: JobAnswer): SdcppFetch & { calls: string[]; bodies: unknown[] } {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  let pollIndex = 0;
  const impl = (async (url: string, init: RequestInit) => {
    calls.push(`${String(init.method ?? 'GET')} ${url}`);
    if (typeof init.body === 'string') bodies.push(JSON.parse(init.body));
    if (url.endsWith('/img_gen')) {
      const submit = answers.submit ?? {
        status: 202,
        body: { id: 'job_1', poll_url: '/sdcpp/v1/jobs/job_1', status: 'queued' },
      };
      return new Response(JSON.stringify(submit.body), { status: submit.status });
    }
    const poll = answers.polls?.[pollIndex++] ?? {
      status: 200,
      body: {
        id: 'job_1',
        status: 'completed',
        result: { images: [{ b64_json: PNG.toString('base64'), index: 0 }], output_format: 'png' },
      },
    };
    return new Response(JSON.stringify(poll.body), { status: poll.status });
  }) as SdcppFetch & { calls: string[]; bodies: unknown[] };
  impl.calls = calls;
  impl.bodies = bodies;
  return impl;
}

function request(overrides: Partial<SdcppJobRequest> = {}): SdcppJobRequest {
  const server = fakeServer();
  return {
    backend: sdcppConfig(),
    server: server.handle,
    prompt: 'turn this sketch into a 3d render',
    width: 768,
    height: 768,
    seed: 4242,
    referenceImages: [PNG.toString('base64')],
    alternatives: ['grok-imagine'],
    fetchImpl: fetchFor({}),
    ...overrides,
  };
}

describe('the async reference-edit job (A15)', () => {
  it('submits, polls, and returns the image with the seed and size it asked for', async () => {
    const fetchImpl = fetchFor({
      polls: [
        { status: 200, body: { id: 'job_1', status: 'queued', queue_position: 0 } },
        {
          status: 200,
          body: {
            id: 'job_1',
            status: 'completed',
            result: { images: [{ b64_json: PNG.toString('base64'), index: 0 }] },
          },
        },
      ],
    });
    const result = await runSdcppImageJob(request({ fetchImpl, pollIntervalMs: 5 }));
    expect(result.bytes).toEqual(PNG);
    expect(result.mime).toBe('image/png');
    expect(result.seed).toBe(4242);
    expect(result.width).toBe(768);
    expect(result.jobId).toBe('job_1');
    expect(fetchImpl.calls[0]).toBe('POST http://127.0.0.1:8093/sdcpp/v1/img_gen');
    expect(fetchImpl.calls[1]).toBe('GET http://127.0.0.1:8093/sdcpp/v1/jobs/job_1');
    expect(fetchImpl.calls).toHaveLength(3); // second poll lands on the completed answer
  });

  it('sends ref_images only when references were given', async () => {
    const withRefs = fetchFor({});
    await runSdcppImageJob(request({ fetchImpl: withRefs, pollIntervalMs: 5 }));
    expect((withRefs.bodies[0] as Record<string, unknown>)['ref_images']).toHaveLength(1);

    const withoutRefs = fetchFor({});
    await runSdcppImageJob(
      request({ referenceImages: [], fetchImpl: withoutRefs, pollIntervalMs: 5 }),
    );
    expect('ref_images' in (withoutRefs.bodies[0] as Record<string, unknown>)).toBe(false);
  });

  it('reports a job the server failed, with the server reason', async () => {
    const fetchImpl = fetchFor({
      polls: [{ status: 200, body: { id: 'job_1', status: 'failed', error: 'out of memory in vae' } }],
    });
    await expect(
      runSdcppImageJob(request({ fetchImpl, pollIntervalMs: 5 })),
    ).rejects.toThrow(
      /qwen-local: the \/sdcpp\/v1\/img_gen job job_1 failed: out of memory in vae/,
    );
  });

  it('refuses a 202 with no poll_url instead of guessing', async () => {
    const fetchImpl = fetchFor({ submit: { status: 202, body: { id: 'job_9' } } });
    await expect(runSdcppImageJob(request({ fetchImpl }))).rejects.toThrow(
      /accepted \/sdcpp\/v1\/img_gen with 202 but returned no poll_url/,
    );
  });

  it('names the endpoint and body when submit is rejected', async () => {
    const fetchImpl = fetchFor({ submit: { status: 500, body: { error: 'bad ref_images' } } });
    await expect(runSdcppImageJob(request({ fetchImpl }))).rejects.toThrow(
      /sd-server returned HTTP 500 for \/sdcpp\/v1\/img_gen.*bad ref_images/s,
    );
  });

  it('gives up at the job deadline and warns the render may still own the GPU (A15)', async () => {
    const backend = sdcppConfig({ request_timeout_ms: 1000 });
    const fetchImpl = fetchFor({
      polls: Array.from({ length: 40 }, () => ({
        status: 200,
        body: { id: 'job_1', status: 'queued', queue_position: 0 },
      })),
    });
    await expect(runSdcppImageJob(request({ backend, fetchImpl }))).rejects.toThrow(
      /did not finish within request_timeout_ms.*may still be running on the GPU/s,
    );
  });

  it('applies the shipped abort rule on the job path, same as txt2img (A12)', async () => {
    const server = fakeServer();
    const controller = new AbortController();
    const fetchImpl = fetchFor({
      polls: [
        {
          status: 200,
          body: {
            id: 'job_1',
            status: 'completed',
            result: { images: [{ b64_json: PNG.toString('base64') }] },
          },
        },
      ],
    });
    controller.abort();
    await expect(
      runSdcppImageJob(
        request({ server: server.handle, signal: controller.signal, fetchImpl }),
      ),
    ).rejects.toThrow(/the turn was cancelled while.*Forge stopped its own sd-server/s);
    expect(server.stopCalls()).toBe(1);
  });

  it('cuts a hung poll at request_timeout_ms instead of waiting on the 30-minute fetch timeout', async () => {
    const backend = sdcppConfig({ request_timeout_ms: 300 });
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (url.endsWith('/img_gen')) {
        return new Response(
          JSON.stringify({ id: 'job_1', poll_url: '/sdcpp/v1/jobs/job_1', status: 'queued' }),
          { status: 202 },
        );
      }
      // A poll that never answers until its signal fires.
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }) as SdcppFetch;
    const started = Date.now();
    await expect(
      runSdcppImageJob(request({ backend, fetchImpl, pollIntervalMs: 5 })),
    ).rejects.toThrow(/job job_1 did not finish within request_timeout_ms/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('applies the abort rule when the turn is cancelled during submit', async () => {
    const server = fakeServer();
    const controller = new AbortController();
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      controller.abort();
      throw init.signal?.reason ?? new Error('aborted');
    }) as SdcppFetch;
    await expect(
      runSdcppImageJob(request({ server: server.handle, signal: controller.signal, fetchImpl })),
    ).rejects.toThrow(/the turn was cancelled while.*Forge stopped its own sd-server/s);
    expect(server.stopCalls()).toBe(1);
    expect(server.activeUses()).toBe(0);
  });

  it('keeps the server claimed for every poll, so the idle timer cannot stop it mid-render', async () => {
    // A warm edit measured 174-606s and idle_timeout_ms defaults to 600s: if the
    // poll loop sat outside withActivity, activeUses would be 0 and Forge would
    // stop its own server in the middle of the job.
    const server = fakeServer();
    const activeDuringPolls: number[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (String(init.method ?? 'GET') === 'GET') activeDuringPolls.push(server.activeUses());
      if (url.endsWith('/img_gen')) {
        return new Response(
          JSON.stringify({ id: 'job_1', poll_url: '/sdcpp/v1/jobs/job_1', status: 'queued' }),
          { status: 202 },
        );
      }
      return new Response(
        JSON.stringify({
          id: 'job_1',
          status: 'completed',
          result: { images: [{ b64_json: PNG.toString('base64'), index: 0 }] },
        }),
      );
    }) as SdcppFetch;
    await runSdcppImageJob(
      request({ server: server.handle, fetchImpl, pollIntervalMs: 5 }),
    );
    expect(activeDuringPolls).toEqual([1]);
    expect(server.activeUses()).toBe(0);
  });

  it('gates the spawn on free VRAM, failing closed like the sync path', async () => {
    const server = fakeServer({ spawnNeeded: true });
    const probe = vi.fn(async () => [gpu(11_000)]);
    // The gate lives in sdcppVramGate and is reached through beforeSpawn; a
    // refusal here must happen before the POST, so no fetch call is recorded.
    const fetchImpl = fetchFor({});
    // The real assertVramAvailable runs, reached through beforeSpawn with the
    // injected probe — not a re-implementation of the gate inside the fake.
    await expect(
      runSdcppImageJob({ ...request({ fetchImpl, server: server.handle }), probe }),
    ).rejects.toThrow(/only 1[.,]288 MB free on GPU 2/);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('refuses a completed job that carried no image', async () => {
    const fetchImpl = fetchFor({
      polls: [{ status: 200, body: { id: 'job_1', status: 'completed', result: { images: [] } } }],
    });
    await expect(
      runSdcppImageJob(request({ fetchImpl, pollIntervalMs: 5 })),
    ).rejects.toThrow(
      /reported job job_1 complete but put no image in result\.images\[0\]/,
    );
  });

  it('refuses bytes that are not an image', async () => {
    const fetchImpl = fetchFor({
      polls: [
        {
          status: 200,
          body: {
            id: 'job_1',
            status: 'completed',
            result: { images: [{ b64_json: Buffer.from('plain text').toString('base64') }] },
          },
        },
      ],
    });
    await expect(
      runSdcppImageJob(request({ fetchImpl, pollIntervalMs: 5 })),
    ).rejects.toThrow(/not a PNG, JPEG, GIF, BMP or WebP image/);
  });
});

describe('job image extraction (probe 0.3a extractor bug)', () => {
  it('reads the observed { b64_json, index } shape', () => {
    expect(firstImageBase64([{ b64_json: PNG.toString('base64'), index: 0 }])).toBe(
      PNG.toString('base64'),
    );
  });

  it('tolerates a bare base64 string entry', () => {
    expect(firstImageBase64([PNG.toString('base64')])).toBe(PNG.toString('base64'));
  });

  it('returns undefined for the shapes that carry no image', () => {
    expect(firstImageBase64(undefined)).toBeUndefined();
    expect(firstImageBase64([])).toBeUndefined();
    expect(firstImageBase64([{ index: 0 }])).toBeUndefined();
    expect(firstImageBase64([''])).toBeUndefined();
  });
});
