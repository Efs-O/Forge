export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface DuckDuckGoOutcome {
  blocked: boolean;
  results: SearchResult[];
}

export const DUCKDUCKGO_URL = 'https://html.duckduckgo.com/html/';

/** Extract organic results from DuckDuckGo's static HTML endpoint response. */
export function extractDuckDuckGoResults(html: string, maxResults: number): DuckDuckGoOutcome {
  const parsed = parseResultBlocks(html);
  const blocked = parsed.length === 0 && hasAnomalyMarker(html);
  return { blocked, results: parsed.slice(0, maxResults) };
}

function parseResultBlocks(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  for (const block of findResultBlocks(html)) {
    if (block.classes.includes('result--ad') || block.classes.includes('result--sponsored')) {
      continue;
    }
    const anchor = findFirstElementByClass(block.html, 'result__a');
    if (!anchor) continue;
    const title = htmlToText(anchor.html);
    const href = readAttribute(anchor.attributes, 'href');
    const url = href ? unwrapDuckDuckGoUrl(decodeHtmlEntities(href)) : undefined;
    if (!title || !url) continue;
    const snippetElement = findFirstElementByClass(block.html, 'result__snippet');
    results.push({
      title,
      url,
      snippet: snippetElement ? htmlToText(snippetElement.html) : '',
    });
  }
  return results;
}

function findResultBlocks(html: string): Array<{ classes: string[]; html: string }> {
  const blocks: Array<{ classes: string[]; html: string }> = [];
  const opening = /<div\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(html))) {
    const attributes = match[0].slice(4, -1);
    const classes = (readAttribute(attributes, 'class') ?? '').split(/\s+/).filter(Boolean);
    if (!classes.includes('result')) continue;
    const end = findMatchingTag(html, 'div', opening.lastIndex);
    if (!end) break;
    blocks.push({ classes, html: html.slice(opening.lastIndex, end.start) });
    opening.lastIndex = end.end;
  }
  return blocks;
}

function findFirstElementByClass(
  html: string,
  className: string,
): { attributes: string; html: string } | undefined {
  const opening = /<([a-z][\w:-]*)\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(html))) {
    const attributes = match[2] ?? '';
    const classes = (readAttribute(attributes, 'class') ?? '').split(/\s+/);
    if (!classes.includes(className)) continue;
    const tag = (match[1] ?? '').toLowerCase();
    const end = findMatchingTag(html, tag, opening.lastIndex);
    if (!end) return undefined;
    return { attributes, html: html.slice(opening.lastIndex, end.start) };
  }
  return undefined;
}

function findMatchingTag(
  html: string,
  tagName: string,
  from: number,
): { start: number; end: number } | undefined {
  const tags = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi');
  tags.lastIndex = from;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(html))) {
    if (match[0].startsWith('</')) depth -= 1;
    else if (!/\/\s*>$/.test(match[0])) depth += 1;
    if (depth === 0) return { start: match.index, end: tags.lastIndex };
  }
  return undefined;
}

function readAttribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(
    attributes,
  );
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function unwrapDuckDuckGoUrl(href: string): string | undefined {
  try {
    let url = new URL(href, DUCKDUCKGO_URL);
    if (
      (url.hostname === 'duckduckgo.com' || url.hostname === 'www.duckduckgo.com') &&
      url.pathname === '/l/'
    ) {
      const target = url.searchParams.get('uddg');
      if (!target) return undefined;
      url = new URL(target);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
    rsquo: '’',
    lsquo: '‘',
    rdquo: '”',
    ldquo: '“',
    mdash: '—',
    ndash: '–',
  };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code.startsWith('#x') || code.startsWith('#X')) {
      return codePoint(Number.parseInt(code.slice(2), 16));
    }
    if (code.startsWith('#')) return codePoint(Number.parseInt(code.slice(1), 10));
    return named[code.toLowerCase()] ?? entity;
  });
}

function codePoint(value: number): string {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : '\uFFFD';
}

function hasAnomalyMarker(html: string): boolean {
  return /anomaly|captcha|bot\s+detection|automated\s+queries|unusual\s+(?:traffic|activity)|security\s+challenge|not\s+a\s+robot/i.test(
    html,
  );
}
