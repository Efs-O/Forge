import { z } from 'zod';

/**
 * `tools:` — settings the tool layer reads at call time, not at registration.
 * Split out of `schema.ts` the way `fetchSchema.ts` and `jobsSchema.ts` were,
 * so the file that holds the whole config shape does not grow past its own
 * 500-line cap (the rule `tools.file_length_warning` exists to enforce).
 *
 * Every block here is OFF when absent: a tool result must not change for a
 * workspace that never asked for it. The 500-line file cap is this repo's
 * convention, not a universal one, so there is no built-in default to fall
 * back on — `elapsed_time_note` uses the same "absent means off" shape.
 */
export const FileLengthWarningSchema = z
  .object({
    /** At this line count the write result starts saying so. */
    warn_at: z.number().int().positive(),
    /** Above this the result says the file is over the limit. */
    max: z.number().int().positive(),
    /**
     * Globs a written file must match for the warning to apply. `**` crosses
     * folders; a pattern with no slash matches at any depth. Absent means every
     * file the tool writes; an empty list matches nothing, so it never warns.
     */
    globs: z.array(z.string().min(1)).optional(),
  })
  .superRefine((warning, context) => {
    // A `warn_at` at or above `max` would skip the "plan where to split" line
    // and reach straight to the over-the-limit one, or warn on every file.
    if (warning.warn_at >= warning.max) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['warn_at'],
        message: 'tools.file_length_warning.warn_at must be lower than max',
      });
    }
  });

/**
 * `tools.edit_diagnostics` — the "new problems after this edit" note a write
 * result carries (`src/tools/editDiagnostics.ts`).
 *
 * This is the ONE block under `tools:` that is ON when absent, against this
 * file's own "absent means off" rule, and it is a deliberate exception: the
 * tools-expansion plan priced the cost (up to `settle_ms` per edit, two seconds
 * by default) against the shell rounds it replaces — 271 `tsc`/`eslint` rounds
 * in the audit window, each of them answering the question this note answers in
 * the round the edit already spent. `enabled: false` restores the results every
 * write tool produced before 2026-10-29, which is the escape hatch for a user
 * who does not want two seconds per edit.
 *
 * `settle_ms` is the whole wait, not a sleep: a matching diagnostics event
 * shortens it to a 300 ms quiet period, so the default is a ceiling rather than
 * a cost. 0 means read once immediately after the write, accepting that the
 * language service may not have looked yet.
 */
export const EditDiagnosticsSchema = z
  .object({
    /** Off restores today's write results exactly: no note, no wait. */
    enabled: z.boolean().optional(),
    /** 0-15000 ms; the ceiling on the wait for the language service. */
    settle_ms: z.number().int().min(0).max(15_000).optional(),
    /** 1-50 problems a result may name; the rest are counted, not shown. */
    max_items: z.number().int().min(1).max(50).optional(),
  })
  .strict()
  .optional();

export const ToolsConfigSchema = z
  .object({
    /**
     * The file-length warning. Absent means no write tool result changes: the
     * cap is this repo's rule, so a fresh workspace gets nothing until its own
     * `FORGE.md` or config says otherwise.
     */
    file_length_warning: FileLengthWarningSchema.optional(),
    /** ON when absent — see `EditDiagnosticsSchema` above for why this block
     * breaks the "absent means off" rule the rest of this file follows. */
    edit_diagnostics: EditDiagnosticsSchema,
  })
  .optional();

/**
 * `skills:` — the top-level block that turns the skills feature off.
 *
 * Absent means ON: the only thing this block can do is turn skills off, and it
 * takes `skills.enabled: false` to do it (`SkillsService.isEnabled` reads
 * `skills?.enabled !== false`). A config that never mentions `skills:` still
 * gets the catalog and the advertised `load_skill`. So unlike `edit_diagnostics`
 * above, this block does NOT follow the "absent means off" rule the rest of this
 * file follows — it is the one block here that defaults to on. Strict on purpose:
 * an owner who writes a key that does not exist should be told, not have it
 * dropped silently — a skill's own `config.json` is where a skill's settings
 * live, never here.
 */
export const SkillsConfigSchema = z
  .object({
    /** Off hides the catalog, the `load_skill` schema and every skill's text. */
    enabled: z.boolean().optional(),
  })
  .strict()
  .optional();
