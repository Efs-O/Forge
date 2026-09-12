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
