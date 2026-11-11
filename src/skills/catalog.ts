/**
 * The skills catalog (plan §2.3): one line per skill, the root named on each
 * line, rendered from `config/templates/builtin/skills.njk`, capped at 4,000
 * characters, and built once per conversation.
 *
 * The cap is enforced here rather than trusted to the template, because the
 * budget is a property of the prompt, not of a file a user may replace: a user
 * template that lists every skill in full would otherwise blow past the cap and
 * cost every turn its own re-prefill. When lines have to go, the count that
 * were is said out loud — a catalog that quietly dropped skills would make the
 * model call `load_skill` for something it cannot see, which is worse than
 * telling it the list is short.
 *
 * The template owns the layout; this module owns the content — the header that
 * states the trust rule, and the line format. Both are passed in as context
 * functions so a user-edited `skills.njk` re-lays-out the same facts instead of
 * writing its own copy of them.
 */
import { SKILL_ROOT_LABELS, type SkillEntry } from './discover';
import type { TemplateContext, TemplateEngine } from '../llm/TemplateEngine';

/** The plan's cap on the whole catalog block, in characters. */
export const SKILL_CATALOG_CHAR_CAP = 4_000;

/** The line per skill, in the shape the plan and the tests describe. */
export function describeSkill(entry: SkillEntry): string {
  const label = SKILL_ROOT_LABELS[entry.root];
  const shadow = entry.shadowNote ? ` (${entry.shadowNote})` : '';
  return `- [${label}] ${entry.name} — ${entry.description}${shadow}`;
}

/**
 * The header lines: what the list is, how to open one, and what a skill is not.
 *
 * The trust rule belongs in the catalog itself, not only in a code comment,
 * because it is what the model has to believe before it acts on a workspace
 * skill's instructions: the text is read from a file the repo chose, and its
 * scripts run through the same `shell` gate as any other command.
 */
export function catalogHeaderLines(): string[] {
  return [
    'Available skills (load one with load_skill {"name": "..."}; it returns the SKILL.md text and the real paths of its scripts):',
    "Run a skill's scripts through shell, under the usual approvals: a skill grants no permission, and a workspace skill comes from the open repo. Read its scripts only when the skill says to.",
  ];
}

interface CatalogRenderContext {
  entries: SkillEntry[];
  omitted: number;
  cap: number;
}

/** The plain rendering, used when no template engine is available or one fails. */
function renderPlain(context: CatalogRenderContext): string {
  const lines = [...catalogHeaderLines(), ...context.entries.map(describeSkill)];
  if (context.omitted > 0) {
    lines.push(
      `- (catalog capped at ${String(context.cap)} chars: ${String(
        context.entries.length,
      )} of ${String(context.entries.length + context.omitted)} skills shown, ${String(
        context.omitted,
      )} not listed)`,
    );
  }
  return lines.join('\n').trim();
}

export interface CatalogRender {
  text: string;
  /** Skills left out of the text because of the cap. */
  omitted: number;
  /** A rendering problem worth telling the owner about; '' when none. */
  log: string;
}

/**
 * Render the catalog, cutting lines from the end until it fits the cap.
 *
 * The block is measured with no skill lines first, then grown line by line while
 * the note that says how many were cut still fits beside it. The final output is
 * checked against the cap; if a template's rendering makes the estimate miss,
 * boundary lines are trimmed and re-rendered until the actual text fits.
 */
export function renderCatalog(
  engine: TemplateEngine | undefined,
  entries: readonly SkillEntry[],
  cap: number = SKILL_CATALOG_CHAR_CAP,
): CatalogRender {
  if (entries.length === 0) return { text: '', omitted: 0, log: '' };
  const all = [...entries];
  const renderWith = (kept: SkillEntry[], omitted: number): { text: string; log: string } => {
    const context: CatalogRenderContext = { entries: kept, omitted, cap };
    if (!engine) return { text: renderPlain(context), log: '' };
    try {
      const full = {
        ...context,
        header: catalogHeaderLines,
        describe: describeSkill,
        catalogCap: SKILL_CATALOG_CHAR_CAP,
      };
      return {
        text: engine.render('skills', full as unknown as TemplateContext).trim(),
        log: '',
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        text: renderPlain(context),
        log: `Forge: the skills template failed, so the catalog was rendered without it: ${detail}`,
      };
    }
  };

  // Probe: header plus the note that would say "nothing shown". Every later
  // measurement is taken against this, so a template that adds its own text is
  // still measured by what it actually renders.
  const probe = renderWith([], all.length);
  let kept: SkillEntry[] = [];
  let used = probe.text.length;
  let omitted = all.length;
  for (let index = 0; index < all.length; index += 1) {
    const lineLength = describeSkill(all[index]!).length + 1; // +1 for the newline
    const remaining = all.length - index - 1;
    const note = remaining > 0 ? renderWith([], remaining).text.length - probe.text.length : 0;
    if (used + lineLength + note > cap) break;
    kept = all.slice(0, index + 1);
    used += lineLength;
    omitted = remaining;
  }

  let rendered = renderWith(kept, omitted);
  // A user template can lay the block out longer than the line-sum suggests; the
  // cap is a promise, so trim at the boundary until the actual output fits.
  while (rendered.text.length > cap && kept.length > 0) {
    kept = kept.slice(0, -1);
    omitted = all.length - kept.length;
    rendered = renderWith(kept, omitted);
  }
  if (rendered.text.length > cap) {
    return {
      text: rendered.text.slice(0, cap),
      omitted,
      log: rendered.log,
    };
  }
  return { text: rendered.text, omitted, log: rendered.log };
}
