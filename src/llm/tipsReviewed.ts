/**
 * Which project tips the owner's reviewer has already decided to keep.
 *
 * `docs/CODING_TIPS.md` keeps tips that name a path or fact of one repo or PC,
 * so after a review most of them stay where they are. The every-tenth review
 * ping (`src/tools/tipsWriteGuard.ts`) counts only the tips that are neither in
 * the shipped table nor marked here, so a reviewed keeper never triggers another
 * review.
 *
 * The mark is one HTML comment line at the end of the project file:
 * `<!-- tips reviewed: 1a2b3c4d 5e6f7a8b … -->`, one 8-hex hash per kept tip.
 * A hash covers the tip's text, so a tip that is later reworded counts as new
 * and gets reviewed again. `src/llm/codingTips.ts` strips the line before the
 * table reaches a prompt. `scripts/mark-tips-reviewed.mjs` rewrites it after a
 * review.
 *
 * Leaf module, Node built-ins only: the script loads it with Node's type
 * stripping, which cannot follow extensionless relative imports.
 */

import { createHash } from 'crypto';

/** Numbered tips entries only — prose and headings are not tips. */
export const TIP_ENTRY = /^\s*\d+\.\s+\S/;

/** The review mark, a whole line of its own. */
export const REVIEWED_MARK_LINE = /^<!-- tips reviewed:([0-9a-f ]*)-->[ \t]*$/m;

/**
 * The key that identifies an entry. The number is STRIPPED: entries are numbered
 * per section, so the duplicate an agent actually writes — the same tip appended
 * as `4.` under a section whose copy is `1.` — would otherwise key differently
 * and pass. What survives is the tip text itself, normalised.
 */
export function tipEntryKey(line: string): string {
  return line
    .replace(/^\s*\d+\.\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function tipEntryKeys(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => TIP_ENTRY.test(line))
    .map(tipEntryKey);
}

export function tipHash(key: string): string {
  return createHash('sha1').update(key, 'utf8').digest('hex').slice(0, 8);
}

/** The hashes the file's review mark holds; empty when it has none. */
export function reviewedTipHashes(text: string): Set<string> {
  const match = REVIEWED_MARK_LINE.exec(text);
  return new Set(match ? match[1].split(' ').filter(Boolean) : []);
}

/** The file without its review mark, for the prompt. */
export function withoutReviewedMark(text: string): string {
  return text.replace(REVIEWED_MARK_LINE, '').trimEnd();
}

/**
 * The project file with every tip it holds now, except those the shipped table
 * already has, marked as reviewed. Run after the review's moves and deletions
 * are on disk, so what remains is exactly what was kept.
 */
export function markProjectTipsReviewed(projectText: string, shippedText: string): string {
  const shipped = new Set(tipEntryKeys(shippedText));
  const hashes = [...new Set(tipEntryKeys(projectText).filter((k) => !shipped.has(k)))].map(
    tipHash,
  );
  return `${withoutReviewedMark(projectText)}\n\n<!-- tips reviewed: ${hashes.join(' ')} -->\n`;
}
