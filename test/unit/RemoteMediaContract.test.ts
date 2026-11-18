import { describe, expect, it } from 'vitest';
import {
  REMOTE_MEDIA_PATH_ARGS,
  REMOTE_MEDIA_ROUTES,
  REMOTE_MEDIA_TEXT,
  RemoteMediaCapabilitiesSchema,
  RemoteMediaJobRequestSchema,
} from '../../src/media/remoteMediaContract';

describe('remote media contract', () => {
  it('pins the five routes with no path parameters', () => {
    expect([...REMOTE_MEDIA_ROUTES]).toEqual([
      'GET /v1/media/capabilities',
      'POST /v1/media/jobs',
      'GET /v1/media/job',
      'GET /v1/media/file',
      'POST /v1/media/cancel',
    ]);
  });

  it('names every path-valued argument per tool', () => {
    expect(REMOTE_MEDIA_PATH_ARGS).toEqual({
      generate_image: { path: 'output', reference_paths: 'input-list' },
      upscale_image: { path: 'input' },
      generate_video: { image_path: 'input' },
      generate_music: { source_audio_path: 'input', lyrics_path: 'output' },
    });
  });

  it('refuses an input name that carries a folder', () => {
    const parsed = RemoteMediaJobRequestSchema.safeParse({
      tool: 'upscale_image',
      args: { path: 'cat.png' },
      client: 'laptop',
      inputs: [{ arg: 'path', name: '../policy.yaml', base64: 'AA==' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('spells the shared error texts', () => {
    expect(REMOTE_MEDIA_TEXT.unreachable('http://100.64.0.1:8797')).toBe(
      'The desktop (http://100.64.0.1:8797) did not answer. Image, video and music generation run there: ' +
        'start Forge on the desktop, or run "Forge: Check connection to my desktop".',
    );
    expect(
      REMOTE_MEDIA_TEXT.notListed(
        'grok-imagine (cloud · billed per image)',
        'grok-imagine',
        'image_backends',
      ),
    ).toBe(
      "Not run: grok-imagine (cloud · billed per image) is not allowed from the laptop. Add grok-imagine to cloud_relay.media.image_backends in the desktop's policy.yaml to allow it.",
    );
    // The card's detail carries the model's prompt after a blank line; the
    // refusal quotes only the headline, so the prompt never reaches the laptop.
    expect(
      REMOTE_MEDIA_TEXT.notListed(
        'grok-imagine (cloud · billed per image · xai · m)\n\na fox',
        'grok-imagine',
        'image_backends',
      ),
    ).toBe(
      "Not run: grok-imagine (cloud · billed per image · xai · m) is not allowed from the laptop. Add grok-imagine to cloud_relay.media.image_backends in the desktop's policy.yaml to allow it.",
    );
  });

  it('accepts a capabilities answer carrying the desktop tool definitions', () => {
    const answer = {
      tools: [
        {
          type: 'function',
          function: {
            name: 'upscale_image',
            description: 'Upscale.',
            parameters: { type: 'object' },
          },
        },
      ],
      upscale: true,
      refused: [],
      max_body_bytes: 33_554_432,
    };
    expect(RemoteMediaCapabilitiesSchema.parse(answer)).toEqual(answer);
    const unknownTool = {
      ...answer,
      tools: [{ ...answer.tools[0], function: { ...answer.tools[0]!.function, name: 'shell' } }],
    };
    expect(RemoteMediaCapabilitiesSchema.safeParse(unknownTool).success).toBe(false);
  });
});
