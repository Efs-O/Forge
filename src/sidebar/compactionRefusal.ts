export function compactionRefusalNotice(
  afterChars: number,
  beforeChars: number,
  midTurn = false,
): string {
  const head =
    'Forge: compaction would not have reduced the context ' +
    `(estimated ~${afterChars.toLocaleString()} vs ~${beforeChars.toLocaleString()} characters), ` +
    'so the previous state was kept.';
  // A live turn is still running; advice to start a new chat would be wrong.
  return midTurn
    ? `${head} The turn continues with the previous context.`
    : `${head} Start a new chat, or remove large attachments, if this repeats.`;
}
