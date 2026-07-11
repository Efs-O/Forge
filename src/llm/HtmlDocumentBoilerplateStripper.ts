const HTML_DOC_START_RE =
  /^\s*(?:<!DOCTYPE\s+html\b[^>]*>\s*)?(?:<html\b[^>]*>|<head\b[^>]*>|<meta\b[^>]*(?:charset|viewport)[^>]*>|<title\b[^>]*>)/i;
const BODY_OPEN_RE = /<body\b[^>]*>/i;
const BODY_CLOSE_RE = /\s*<\/body>\s*<\/html>\s*$/i;
const HTML_CLOSE_RE = /\s*<\/html>\s*$/i;
const HTML_CLOSE_MARKERS = ['</body>', '</html>'] as const;

function looksLikeHtmlDocumentStart(text: string): boolean {
  return HTML_DOC_START_RE.test(text);
}

export function stripHtmlDocumentBoilerplateFromFullText(text: string): string {
  if (!looksLikeHtmlDocumentStart(text)) {
    return text;
  }

  const bodyMatch = BODY_OPEN_RE.exec(text);
  if (bodyMatch) {
    return text
      .slice(bodyMatch.index + bodyMatch[0].length)
      .replace(BODY_CLOSE_RE, '')
      .trim();
  }

  return text
    .replace(/^\s*<!DOCTYPE\s+html\b[^>]*>\s*/i, '')
    .replace(/^\s*<html\b[^>]*>\s*/i, '')
    .replace(/^\s*<head\b[^>]*>\s*/i, '')
    .replace(/^(?:\s*<meta\b[^>]*>\s*)+/i, '')
    .replace(/^\s*<title\b[^>]*>[\s\S]*?<\/title>\s*/i, '')
    .replace(/^\s*<\/head>\s*/i, '')
    .replace(/^\s*<body\b[^>]*>\s*/i, '')
    .replace(BODY_CLOSE_RE, '')
    .replace(HTML_CLOSE_RE, '')
    .trim();
}

export class HtmlDocumentBoilerplateStripper {
  private mode: 'undecided' | 'seekBody' | 'passthrough' | 'body' = 'undecided';
  private buffer = '';
  private tailCarry = '';

  push(raw: string): string {
    if (this.mode === 'passthrough') {
      return raw;
    }
    if (this.mode === 'body') {
      const [visible, nextCarry] = stripClosingCarry(raw, this.tailCarry);
      this.tailCarry = nextCarry;
      return visible.replace(BODY_CLOSE_RE, '').replace(HTML_CLOSE_RE, '');
    }

    this.buffer += raw;
    if (this.mode === 'undecided') {
      const trimmed = this.buffer.trimStart();
      if (!trimmed) {
        return '';
      }
      if (!looksLikeHtmlDocumentStart(trimmed)) {
        const visible = this.buffer;
        this.buffer = '';
        this.mode = 'passthrough';
        return visible;
      }
      this.mode = 'seekBody';
    }

    const bodyMatch = BODY_OPEN_RE.exec(this.buffer);
    if (!bodyMatch) {
      return '';
    }

    const visible = this.buffer.slice(bodyMatch.index + bodyMatch[0].length);
    this.buffer = '';
    this.mode = 'body';
    return visible;
  }

  flush(): string {
    if (this.mode === 'body') {
      const visible = this.tailCarry.replace(BODY_CLOSE_RE, '').replace(HTML_CLOSE_RE, '');
      this.tailCarry = '';
      return visible;
    }
    if (!this.buffer) {
      return '';
    }
    const visible = stripHtmlDocumentBoilerplateFromFullText(this.buffer);
    this.buffer = '';
    return visible.replace(BODY_CLOSE_RE, '').replace(HTML_CLOSE_RE, '');
  }
}

function stripClosingCarry(raw: string, carry: string): [string, string] {
  const content = `${carry}${raw}`;
  let bestCarry = '';

  for (const marker of HTML_CLOSE_MARKERS) {
    const maxPartial = Math.min(content.length, marker.length - 1);
    for (let i = 1; i <= maxPartial; i++) {
      const candidate = marker.slice(0, i);
      if (content.endsWith(candidate) && candidate.length > bestCarry.length) {
        bestCarry = candidate;
      }
    }
  }

  if (!bestCarry) {
    return [content, ''];
  }

  return [
    content.slice(0, content.length - bestCarry.length),
    content.slice(content.length - bestCarry.length),
  ];
}
