/**
 * The persisted shape of the two prompt-head pins (`forgeInstructionsPin.ts` and
 * `codingTipsPin.ts`), in a leaf module of its own on purpose.
 *
 * `sessionTypes.ts` validates both when it builds the conversation schema, and
 * each pin module derives its runtime type from its own schema. Declaring the
 * schemas in either of those two closes an import cycle that breaks at module
 * EVALUATION, not at type-check: a pin module imports `compactionWindow`, which
 * reaches `compactionUserContext` → `imageParts` → `ConversationOps` →
 * `sessionTypes`, and by then `sessionTypes` needs a schema the pin module has
 * not finished defining — so the field reads
 * `TypeError: Cannot read properties of undefined (reading 'optional')` on the
 * first import of the day. A module that imports only `zod`, plus a module that
 * imports nothing at all, cannot be in that cycle, so both shapes live here.
 */

import { z } from 'zod';
import { TIPS_PIN_TEXT_MAX_CHARS } from '../llm/codingTipsBudget';

/** FORGE.md's pin: `text` is '' when no FORGE.md applies. */
export const forgeInstructionsPinSchema = z
  .object({
    text: z.string(),
    windowStart: z.number().int().min(0),
    /** The newest text delivered by a note, and the message that carries it. */
    announced: z.object({ text: z.string(), messageIndex: z.number().int() }).strict().optional(),
  })
  .strict();

/**
 * The ceiling on a pinned tips block, imported from `codingTipsBudget.ts`, the
 * module that owns the budget: `loadCodingTips` can only ever produce the
 * shipped allowance plus the project allowance plus its headings, so anything
 * larger in session.json is corruption — and an unbounded string is the one
 * field a corrupted save could grow without end. The FORGE.md pin above is
 * deliberately NOT bounded: its producer clamps the instruction chain to
 * `MAX_INSTRUCTION_BYTES`, and a ceiling this build cannot reproduce would drop
 * a whole chat at load rather than shrink one field.
 */

/**
 * The tips pin: the same shape minus `announced`, because a changed tips table
 * is not announced — it reaches the model when the window moves.
 */
export const codingTipsPinSchema = z
  .object({
    /** '' when there is no table at all, so the pin can hold it without `undefined`. */
    text: z.string().max(TIPS_PIN_TEXT_MAX_CHARS),
    windowStart: z.number().int().min(0),
  })
  .strict();
