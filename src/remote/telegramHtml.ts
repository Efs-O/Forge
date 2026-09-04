/**
 * Telegram's HTML parse mode, escaped at one choke point.
 *
 * Owner of every Forge → Telegram rich-text send. The rule that makes rich text
 * safe is the same everywhere it is used: escape the whole message first, then
 * re-insert markup only for the spans Forge itself decided on. A model name, a
 * conversation title or a workspace path is content, never markup — the moment
 * one is trusted as HTML, an angle bracket in it silently eats the rest of the
 * message, and Telegram rejects the send with no clue which text did it.
 */
export function escapeTelegramHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/**
 * Escapes the message whole, then hands each line back for markup.
 *
 * Every rich list Forge sends is built as plain text first and decorated
 * afterwards, line by line, against its own structure — a numbered entry, a
 * section label, a group heading. Escaping first is what makes that safe: by
 * the time `decorate` sees a line, every angle bracket in it is already an
 * entity, so nothing a conversation title or a model name contains can look
 * like the structure being matched.
 */
export function markupTelegramLines(
  text: string,
  decorate: (line: string, index: number) => string,
): string {
  return escapeTelegramHtml(text).split('\n').map(decorate).join('\n');
}

/**
 * `12. rest` → `<b>12.</b> rest`.
 *
 * Every list Forge sends numbers its entries, and the number is the part the
 * user types back into `/select`, `/model` or `/new` — so it is the part worth
 * making findable when the list is a wall of names and paths.
 */
export function boldLeadingNumber(line: string): string {
  const match = /^(\d+\.)(\s.*)$/u.exec(line);
  return match ? `<b>${match[1]}</b>${match[2]}` : line;
}

/** `12. rest` → `<b>12. rest</b>`, for entries whose whole line is a title. */
export function boldNumberedLine(line: string): string {
  return /^\d+\.\s/u.test(line) ? `<b>${line}</b>` : line;
}

/** Bolds `Label:` at the head of a line, leaving the value it introduces plain. */
export function boldLineLabel(line: string, labels: ReadonlySet<string>): string {
  const match = /^([^:]+):(.*)$/u.exec(line);
  if (!match || !labels.has(match[1]!)) return line;
  return `<b>${match[1]}:</b>${match[2]}`;
}

/**
 * Sends `text` rich where the transport parses HTML, and unchanged where it
 * does not — the plain build is the source of truth, so a transport without
 * rich text never shows markup or escaping as literal characters.
 */
export async function sendRichText(
  channel: {
    send(chatId: string, text: string, options?: { signal?: AbortSignal }): Promise<void>;
    sendHtml?(chatId: string, html: string, options?: { signal?: AbortSignal }): Promise<void>;
  },
  chatId: string,
  text: string,
  decorate: (line: string, index: number) => string,
  options?: { signal?: AbortSignal },
): Promise<void> {
  if (channel.sendHtml) {
    await channel.sendHtml(chatId, markupTelegramLines(text, decorate), options);
    return;
  }
  await channel.send(chatId, text, options);
}
