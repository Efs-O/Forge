/** Shared, browser-safe query language and scoring for the sessions panel. */
export interface SessionSearchQuery {
  include: string[];
  exclude: string[];
}

export interface SessionSearchFields {
  title: string;
  badge: string;
  body?: string;
}

export interface SessionSearchMatch {
  score: number;
  snippet?: string;
}

/**
 * Space-separated terms are ANDed; double quotes keep a phrase together and a
 * leading minus excludes a term/phrase. An unfinished quote consumes the rest
 * of the input as a phrase, so typing a quote does not flash unrelated results.
 * Empty quotes and a lone minus have no searchable text and are ignored.
 */
export function parseSessionSearchQuery(text: string): SessionSearchQuery {
  const result: SessionSearchQuery = { include: [], exclude: [] };
  for (const token of text.match(/-?"[^"]*(?:"|$)|[^\s]+/gu) ?? []) {
    const negative = token.startsWith('-');
    const value = negative ? token.slice(1) : token;
    const term = (value.startsWith('"') ? value.slice(1).replace(/"$/u, '') : value).trim();
    const terms = negative ? result.exclude : result.include;
    if (term && !terms.some((existing) => existing.toLowerCase() === term.toLowerCase()))
      terms.push(term);
  }
  return result;
}

/** Literal text only: query punctuation never becomes a regular expression. */
function pattern(term: string, global = false): RegExp {
  return new RegExp(term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), global ? 'giu' : 'iu');
}

/** Every positive must occur in some field; any excluded term rejects the chat. */
export function matchSessionSearch(
  query: SessionSearchQuery,
  fields: SessionSearchFields,
): SessionSearchMatch | undefined {
  const body = fields.body ?? '';
  const texts = [fields.title, fields.badge, body];
  if (query.exclude.some((term) => texts.some((text) => pattern(term).test(text)))) return;
  let score = 0;
  let firstBodyMatch = body.length;
  let firstTermLength = 0;
  for (const term of query.include) {
    const re = pattern(term);
    const inTitle = re.test(fields.title);
    const inBadge = re.test(fields.badge);
    const bodyMatch = re.exec(body);
    if (!inTitle && !inBadge && !bodyMatch) return;
    score += inTitle ? 10 : inBadge ? 5 : 1;
    if (
      bodyMatch &&
      (bodyMatch.index < firstBodyMatch ||
        (bodyMatch.index === firstBodyMatch && bodyMatch[0].length > firstTermLength))
    ) {
      firstBodyMatch = bodyMatch.index;
      firstTermLength = bodyMatch[0].length;
    }
  }
  if (firstBodyMatch === body.length) return { score };
  // Bounded previews, centred on an actual body match. A long quoted phrase is
  // kept whole (queries are capped at 512 chars by the request boundary).
  const start = Math.max(0, firstBodyMatch - 60);
  const end = Math.min(body.length, start + Math.max(220, firstTermLength + 80));
  const snippet = `${start > 0 ? '…' : ''}${body.slice(start, end)}${end < body.length ? '…' : ''}`;
  return { score, snippet };
}

/** Text segments for React to render safely, including overlapping term hits. */
export function sessionSearchSegments(
  text: string,
  query: SessionSearchQuery,
): { text: string; match: boolean }[] {
  const ranges = query.include.flatMap((term) =>
    [...text.matchAll(pattern(term, true))].map((hit) => ({
      start: hit.index!,
      end: hit.index! + hit[0].length,
    })),
  );
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: { start: number; end: number }[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  const parts: { text: string; match: boolean }[] = [];
  let cursor = 0;
  for (const range of merged) {
    if (range.start > cursor) parts.push({ text: text.slice(cursor, range.start), match: false });
    parts.push({ text: text.slice(range.start, range.end), match: true });
    cursor = range.end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
  return parts;
}
