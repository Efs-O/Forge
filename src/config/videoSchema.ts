import { z } from 'zod';

/**
 * `view_video` frame extraction. `frame_max_dimension` is the context knob, not
 * a quality one: measured on a 5 s clip against Qwen3.8-27B, unscaled 1920x1088
 * costs 22,501 prompt tokens (rejected at 16k ctx), 640 px costs 2,479, and
 * 384 px costs 983.
 */
export const TopLevelVideoConfigSchema = z
  .object({
    max_duration_seconds: z.number().positive().optional(),
    max_frames: z.number().int().positive().max(64).optional(),
    frame_max_dimension: z.number().int().min(64).max(4096).optional(),
    // ffmpeg -q:v: 2 is best quality, higher is smaller.
    frame_quality: z.number().int().min(2).max(31).optional(),
    ffmpeg_path: z.string().optional(),
  })
  .optional();
