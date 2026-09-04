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
