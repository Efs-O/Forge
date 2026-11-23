import { z } from 'zod';

/** Top-level view_video frame extraction settings in config.yaml. */
export const TopLevelVideoConfigSchema = z
  .object({
    max_duration_seconds: z.number().positive().optional(),
    max_frames: z.number().int().positive().max(64).optional(),
    frame_max_dimension: z.number().int().min(64).max(4096).optional(),
    frame_quality: z.number().int().min(2).max(31).optional(),
    ffmpeg_path: z.string().optional(),
  })
  .optional();
