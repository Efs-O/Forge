const TELEGRAM_TEXT_LIMIT = 4096;

/** Splits text on Unicode code points so Telegram's message limit is respected. */
export function splitTelegramText(text: string): string[] {
  if (!text) return [''];
  const chunks: string[] = [];
  let chunk = '';
  let characters = 0;
  for (const character of text) {
    if (characters === TELEGRAM_TEXT_LIMIT) {
      chunks.push(chunk);
      chunk = '';
      characters = 0;
    }
    chunk += character;
    characters += 1;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

const FENCE_RE = /^\s*```/;
const HEADING_RE = /^#{1,6}\s+/;

/**
 * Drops markdown markers from a literal-text Telegram message: fence lines,
 * heading hashes, `**` bold and inline backticks. Lines inside a fence are
 * left untouched, so `**kwargs` or a C pointer survives.
 */
export function plainTelegramText(text: string): string {
  let inFence = false;
  const lines: string[] = [];
  for (const line of text.split('\n')) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    lines.push(
      inFence
        ? line
        : line
            .replace(HEADING_RE, '')
            .replace(/\*\*(\S(?:.*?\S)?)\*\*/g, '$1')
            .replace(/`([^`\n]+)`/g, '$1'),
    );
  }
  return lines.join('\n');
}
