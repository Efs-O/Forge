/**
 * The coding-tips budget, in a module that imports nothing on purpose.
 *
 * Two modules have to agree on these numbers: `codingTips.ts` clamps each table
 * to its allowance, and `src/sidebar/pinSchemas.ts` bounds the block that
 * reaches the persisted session. The pin module is a leaf that imports only
 * `zod` (its header explains the cycle that breaks at module EVALUATION), so it
 * cannot import `codingTips.ts` — which reaches `forgeInstructionsChain`. The
 * numbers therefore live here, where both can import them.
 *
 * The ceiling is DERIVED and must stay derived. It used to be a hand-tuned
 * number of its own, and commit 2aa62b7b raised the two allowances from 16 KB /
 * 8 KB to 32 KB / 16 KB without it: a block legal under the new allowances
 * measured 48,163 characters against a 32,000 ceiling, `conversationPersistedSchema`
 * rejected the record, and the whole chat body was quarantined at load.
 * `CodingTipsInjection.test.ts` now pins the relationship.
 */

/** The shipped table is the vendor's: it gets room for the whole list. Sized to
 *  hold a full 180-entry table (`CodingTipsDoc.test.ts`'s cap): 90 entries
 *  measured 12.7 KB on 2026-11-14, so an allowance under 25 KB would truncate a
 *  table the cap allows. */
export const SHIPPED_TIPS_ALLOWANCE = 32_000;

/** The project table grows one line per recorded mistake, so it is capped on its own. */
export const PROJECT_TIPS_ALLOWANCE = 16_000;

/** What `loadCodingTips` adds AROUND the two tables: the shipped heading, the
 *  project heading, the duplicate note, and the blank lines between parts. The
 *  allowances alone are not the block: measured 2026-11-15, a block at both
 *  allowances is 48,163 characters — 163 more than the two allowances together. */
export const TIPS_BLOCK_HEADROOM_CHARS = 1_024;

/** The ceiling a pinned tips block may hold: the largest block `loadCodingTips`
 *  can produce, with headroom. Anything larger in `session.json` is corruption,
 *  and an unbounded string is the one field a corrupted save could grow without
 *  end — which is why this field alone is bounded, and the FORGE.md pin is not. */
export const TIPS_PIN_TEXT_MAX_CHARS =
  SHIPPED_TIPS_ALLOWANCE + PROJECT_TIPS_ALLOWANCE + TIPS_BLOCK_HEADROOM_CHARS;
