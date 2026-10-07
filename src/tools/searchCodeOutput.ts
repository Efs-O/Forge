export interface SearchCodeMatch {
  path: string;
  snippets: string[];
  snippetMatches: boolean[];
  omittedSnippets: number;
}

/** Render retained search matches and name any matching lines hidden by either cap. */
export function renderSearchCodeMatches(matches: SearchCodeMatch[], lineLimit: number): string {
  const outputLines: string[] = [];
  let droppedLines = 0;
  let droppedFiles = 0;
  const renderedFiles = new Set<string>();
  const hasDroppedMatch = (match: SearchCodeMatch): boolean =>
    match.omittedSnippets > 0 || match.snippetMatches.some(Boolean);
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    if (outputLines.length >= lineLimit) {
      droppedLines += match.snippetMatches.filter(Boolean).length + match.omittedSnippets;
      if (!renderedFiles.has(match.path) && hasDroppedMatch(match)) droppedFiles += 1;
      for (const remaining of matches.slice(index + 1)) {
        droppedLines += remaining.snippetMatches.filter(Boolean).length + remaining.omittedSnippets;
        if (!renderedFiles.has(remaining.path) && hasDroppedMatch(remaining)) droppedFiles += 1;
      }
      break;
    }
    outputLines.push(`\n=== ${match.path} ===`);
    renderedFiles.add(match.path);
    for (let snippetIndex = 0; snippetIndex < match.snippets.length; snippetIndex += 1) {
      const snippet = match.snippets[snippetIndex]!;
      if (outputLines.length >= lineLimit) {
        droppedLines +=
          match.snippetMatches.slice(snippetIndex).filter(Boolean).length + match.omittedSnippets;
        break;
      }
      outputLines.push(snippet);
    }
    if (match.omittedSnippets > 0) {
      outputLines.push(`(+${match.omittedSnippets} more matches in this file)`);
    }
  }
  if (droppedLines > 0) {
    outputLines.push(
      `[Output capped at ${lineLimit} lines: ${droppedLines} more matching lines in ${droppedFiles} more file${
        droppedFiles === 1 ? '' : 's'
      } not shown. Narrow with an include glob or a more specific query.]`,
    );
  }
  return outputLines.join('\n');
}
