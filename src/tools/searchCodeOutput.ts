/** The three shapes a `grep_search` call can ask for; `content` is what this tool printed before 2026-10-29. */
export type SearchCodeOutputMode = 'content' | 'files' | 'count';

export interface SearchCodeMatch {
  path: string;
  snippets: string[];
  snippetMatches: boolean[];
  omittedSnippets: number;
  /**
   * Every matching line ripgrep reported for this file, including the ones no
   * snippet showed and the ones the per-file snippet cap never stored.
   *
   * One field owns "how many lines did this file match", because three
   * different answers used to be computed from three different things: the
   * secret gate counted `snippetMatches + omittedSnippets` (so a `files` or
   * `count` search, which stores no snippets at all, counted zero), the
   * output-cap note did the same arithmetic again, and `output:"count"` needs
   * the number for files whose snippets were never kept. Counting the match
   * events as they arrive is the only version that is right for all three.
   */
  matchCount: number;
}

/** Render retained search matches and name any matching lines hidden by either cap. */
export function renderSearchCodeMatches(matches: SearchCodeMatch[], lineLimit: number): string {
  const outputLines: string[] = [];
  let droppedLines = 0;
  let droppedFiles = 0;
  const renderedFiles = new Set<string>();
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    if (outputLines.length >= lineLimit) {
      droppedLines += match.matchCount;
      if (!renderedFiles.has(match.path)) droppedFiles += 1;
      for (const remaining of matches.slice(index + 1)) {
        droppedLines += remaining.matchCount;
        if (!renderedFiles.has(remaining.path)) droppedFiles += 1;
      }
      break;
    }
    outputLines.push(`\n=== ${match.path} ===`);
    renderedFiles.add(match.path);
    let stoppedEarly = false;
    for (let snippetIndex = 0; snippetIndex < match.snippets.length; snippetIndex += 1) {
      const snippet = match.snippets[snippetIndex]!;
      if (outputLines.length >= lineLimit) {
        droppedLines +=
          match.matchCount - match.snippetMatches.slice(0, snippetIndex).filter(Boolean).length;
        stoppedEarly = true;
        break;
      }
      outputLines.push(snippet);
    }
    if (match.omittedSnippets > 0) {
      // The "N more matches in this file" line is output like any other, so it
      // only prints while the budget still has room for it. Pushing it past the
      // limit made the result one line over what the caller asked for. With no
      // room, its count goes into the cap announcement at the end instead, so
      // these matches are never simply dropped from the answer.
      if (outputLines.length < lineLimit) {
        outputLines.push(`(+${match.omittedSnippets} more matches in this file)`);
      } else if (!stoppedEarly) {
        droppedLines += match.omittedSnippets;
      }
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

/**
 * `output:"files"`: one path per line, and nothing else.
 *
 * The caller is deciding *where to look*, not reading hits: a path-only answer
 * costs the model a fraction of the context the same search costs in content
 * mode, which is why the audit's 1,164 shell greps mostly carried `-l`. No
 * header, no snippet, no line number — a header here would put the file name
 * in the output twice.
 */
export function renderSearchCodePaths(matches: SearchCodeMatch[], lineLimit: number): string {
  const shown = matches.slice(0, Math.max(0, lineLimit));
  return shown.map((match) => match.path).join('\n') + fileCapNote(shown, matches.length);
}

/**
 * `output:"count"`: `path:count`, one line per file, in the order ripgrep found
 * them. The count is every matching line rg reported for that file, so a file
 * the caller never sees the contents of still tells the truth — the whole point
 * of asking for counts is to size a search before reading it.
 */
export function renderSearchCodeCounts(matches: SearchCodeMatch[], lineLimit: number): string {
  const shown = matches.slice(0, Math.max(0, lineLimit));
  return (
    shown.map((match) => `${match.path}:${match.matchCount}`).join('\n') +
    fileCapNote(shown, matches.length)
  );
}

/** The tail line for a path or count list cut off by the output line budget. */
function fileCapNote(shown: SearchCodeMatch[], totalFiles: number): string {
  const hidden = totalFiles - shown.length;
  if (hidden <= 0) return '';
  return `\n[Output capped at ${shown.length} lines: ${hidden} more matching file${
    hidden === 1 ? '' : 's'
  } not shown. Narrow with an include glob or a more specific query.]`;
}
