import { describe, expect, it } from 'vitest';
import {
  extractFrames,
  probeVideo,
  resolveFfmpeg,
  type FfmpegTools,
} from '../../src/tools/videoExtract';
import { VIDEO_DEFAULTS } from '../../src/tools/videoTool';

/**
 * The only test here that drives real ffmpeg. Skipped unless ffmpeg resolves
 * AND `FORGE_VIDEO_FIXTURE` points at a clip, so `npm run ci` never depends on
 * a machine having ffmpeg or a video file. The unit tests assert the argv
 * contract; this asserts that ffmpeg actually agrees with it.
 *
 *   FORGE_VIDEO_FIXTURE="/path/to/clip.mp4" npx vitest run test/integration/videoExtractLive.test.ts
 */
const fixture = process.env['FORGE_VIDEO_FIXTURE'];

let tools: FfmpegTools | undefined;
try {
  tools = resolveFfmpeg();
} catch {
  tools = undefined;
}

const enabled = Boolean(fixture) && tools !== undefined;

describe.skipIf(!enabled)('view_video against real ffmpeg', () => {
  it('probes a real clip', async () => {
    const probe = await probeVideo(tools!, fixture!);
    expect(probe.durationSeconds).toBeGreaterThan(0);
    expect(probe.width).toBeGreaterThan(0);
    expect(probe.height).toBeGreaterThan(0);
  });

  it('extracts ordered, downscaled JPEG frames', async () => {
    const probe = await probeVideo(tools!, fixture!);
    const options = { ...VIDEO_DEFAULTS, maxDurationSeconds: 3600 };
    const extraction = await extractFrames(tools!, fixture!, probe, options);

    expect(extraction.frames.length).toBeGreaterThanOrEqual(1);
    const times = extraction.frames.map((frame) => frame.timeSeconds);
    expect([...times].sort((a, b) => a - b)).toEqual(times);

    for (const frame of extraction.frames) {
      const bytes = Buffer.from(frame.jpegBase64, 'base64');
      // JPEG SOI marker: proof ffmpeg wrote a real image, not an empty file.
      expect(bytes[0]).toBe(0xff);
      expect(bytes[1]).toBe(0xd8);
      expect(bytes.byteLength).toBeGreaterThan(1000);
    }
  });
});
