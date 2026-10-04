export function compactionRefusalNotice(afterChars: number, beforeChars: number): string {
  return (
    'Forge: compaction would not have reduced the context ' +
    `(estimated ~${afterChars.toLocaleString()} vs ~${beforeChars.toLocaleString()} characters), ` +
    'so the previous state was kept. Start a new chat, or remove large attachments, if this repeats.'
  );
}
