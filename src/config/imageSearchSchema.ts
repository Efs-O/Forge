import { z } from 'zod';

/**
 * `image_search:` — absent means the `image_search` tool is never advertised.
 *
 * `serpapi_lens` is the only provider: SerpApi's Google Lens engine accepts a
 * public image URL only, so local images go through a one-hour Litterbox upload
 * first. See docs/plans/IMAGE_SEARCH_TOOL_PLAN.md for the live measurements
 * behind the defaults.
 */
export const ImageSearchConfigSchema = z
  .object({
    provider: z.enum(['serpapi_lens']),
    /** SecretStorage key holding the SerpApi key — never the key itself. */
    secret_key_name: z.string().min(1),
    /** Matches per section returned to the model. The raw response is ~400 KB. */
    max_results: z.number().int().min(1).max(20).default(8),
    /**
     * Ask before a LOCAL image (attachment) leaves the machine. Off by default;
     * a public `image_url` search never asks, since nothing private is sent.
     */
    confirm_upload: z.boolean().default(false),
    /**
     * Top match thumbnails saved under .forge/image-search, shown in the sidebar
     * tool row and sent as photos to a remote chat watching the turn. 0 = none.
     */
    thumbnails: z.number().int().min(0).max(8).default(4),
    /** Measured: `type: all` took 52 s, `exact_matches` 18 s. */
    timeout_ms: z.number().int().positive().default(90_000),
  })
  .optional();
