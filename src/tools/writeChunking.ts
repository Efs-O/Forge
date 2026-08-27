/**
 * Ceiling on the content a single write should carry.
 *
 * A tool call's arguments are generated as one JSON string, so a large file
 * body is one unbroken run of output. When the remaining context cannot hold
 * it, generation stops mid-string, llama-server's chat parser throws, and the
 * whole turn is lost — see docs/plans/TOOL_CALL_TRUNCATION_PLAN.md. Staying under this
 * keeps any single call recoverable, and the cost of being wrong is one extra
 * append rather than a dead turn.
 *
 * 6 KB is well under what fits in a healthy turn (a 15.8 KB write succeeded in
 * the session that motivated this) but small enough that late-turn calls, when
 * headroom is thinnest, still land.
 */
export const MAX_SINGLE_WRITE_CHARS = 6000;

/** The chunking instruction, worded once so tool descriptions and recovery guidance agree. */
export const CHUNKED_WRITE_ADVICE =
  `Content over ~${MAX_SINGLE_WRITE_CHARS} characters should be split: ` +
  `write_file for the first chunk, then append_file for each chunk after it.`;
