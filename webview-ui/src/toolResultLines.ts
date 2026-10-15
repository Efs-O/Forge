/** Collapse adjacent duplicate result lines for display without changing stored text. */
export function foldConsecutiveLines(text: string): string {
  const lines = text.split('\n');
  const folded: string[] = [];

  for (let index = 0; index < lines.length; ) {
    const line = lines[index]!;
    let end = index + 1;
    while (end < lines.length && lines[end] === line) end++;
    const count = end - index;
    folded.push(line && count > 1 ? `${line} (×${count})` : line);
    index = end;
  }

  return folded.join('\n');
}
