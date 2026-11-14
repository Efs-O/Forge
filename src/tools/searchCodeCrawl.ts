/**
 * The ripgrep crawl behind `grep_search`: spawn it, parse its JSON events, and
 * stop it once the caller's page is full.
 *
 * Split out of `searchCodeTool.ts` on 2026-10-29 (tools-expansion lane F1, item
 * 1.1) because the page/offset work made the tool file pass the 500-line gate.
 * The split follows the real seam: this file knows how ripgrep behaves, the tool
 * file knows what a result should say. Nothing here reads config, decides
 * secrets, or renders text.
 */
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import type { SearchCodeMatch, SearchCodeOutputMode } from './searchCodeOutput';
import type { RipgrepResolution } from './RipgrepResolver';
import { capSnippetLine } from './searchSnippet';
import {
  exclusionsCoveringRoot,
  resolveSearchCodeScope,
  rgScopeArgs,
  type SearchCodeScope,
} from './searchScope';

/**
 * Per-file snippet cap.
 *
 * Without it, whichever file ripgrep reaches first spends the whole
 * OUTPUT_LINE_LIMIT and every other match is cut off. That is not hypothetical:
 * `.forge/embeddings.index.json` sorts first (dot-directory) and, being a copy
 * of every indexed chunk, matches nearly any query — so a search for "pickup"
 * in a workspace with an index returned 50 lines of index JSON and nothing from
 * the actual sources. The tool looked broken while working.
 */
export const SNIPPETS_PER_FILE_LIMIT = 8;

interface RipgrepLineData {
  text?: string;
}

interface RipgrepPathData {
  text?: string;
}

interface RipgrepMatchData {
  path?: RipgrepPathData;
  lines?: RipgrepLineData;
  line_number?: number;
  submatches?: Array<{ start: number; end: number }>;
}

interface RipgrepContextData {
  path?: RipgrepPathData;
  lines?: RipgrepLineData;
  line_number?: number;
}

type RipgrepEvent =
  | { type: 'match'; data: RipgrepMatchData }
  | { type: 'context'; data: RipgrepContextData }
  | { type: string; data?: unknown };

function isMatchEvent(event: RipgrepEvent): event is { type: 'match'; data: RipgrepMatchData } {
  return event.type === 'match';
}

function isContextEvent(
  event: RipgrepEvent,
): event is { type: 'context'; data: RipgrepContextData } {
  return event.type === 'context';
}

export interface SearchCodeOptions {
  query: string;
  literal: boolean;
  include: string;
  maxResults: number;
  /** Files to skip before the page this call returns. */
  offset: number;
  /**
   * What the caller asked to see. The crawl needs it for one reason: a path or
   * count list prints no lines, so it gets no context lines from ripgrep either
   * — see `searchCodeRgArgs`.
   */
  output: SearchCodeOutputMode;
  /** Context lines the caller asked for; `searchCodeRgArgs` may still send 0. */
  context: number;
  ignoreCase: boolean;
  /** Search paths ignored by VCS ignore files, while keeping tool exclusions. */
  includeIgnored?: boolean;
}

/**
 * The ripgrep argv for one search, built apart from the spawn so it can be
 * tested without a process — the same reason `rgScopeArgs` is its own function.
 *
 * Two decisions here are the ones a model can get wrong and a test cannot see
 * from the result text: `--regexp` must come last-but-one so a query like `--new`
 * is the pattern rather than a flag, and `--context 0` must be sent for the path
 * modes, where every context line ripgrep prints would be thrown away.
 */
export function searchCodeRgArgs(options: SearchCodeOptions, scope: SearchCodeScope): string[] {
  const { query, literal, context, ignoreCase, output, includeIgnored } = options;
  const scopeArgs = rgScopeArgs(scope);
  return [
    '--json',
    ...(literal ? ['--fixed-strings'] : []),
    ...(ignoreCase ? ['--ignore-case'] : []),
    '--line-number',
    '--with-filename',
    // `files` and `count` render no lines at all, so asking ripgrep for context
    // would only make it print lines this call then throws away.
    '--context',
    String(output === 'content' ? context : 0),
    '--hidden',
    // The ignore-file decision and the noise-directory decision are separate;
    // `rgScopeArgs` is the single owner of both (audit F1, 2026-10-03).
    ...scopeArgs,
    ...(includeIgnored && !scopeArgs.includes('--no-ignore-vcs') ? ['--no-ignore-vcs'] : []),
    // Behind --regexp, so a query like `--new` is the pattern, not a flag rg refuses.
    '--regexp',
    query,
    scope.target,
  ];
}

export interface SearchCodeFound {
  /** The files ripgrep reported, up to `offset + maxResults` of them. */
  matches: SearchCodeMatch[];
  /**
   * True when a file beyond the page was seen, so this search is not finished.
   *
   * Only the arrival of a NEW path past the page limit proves that: the crawl
   * also stops when the last file in the page keeps matching and its snippet
   * cap is full, and that says nothing about whether another file exists.
   * Overstating it would make the model page through a search that had already
   * ended, and every extra page is a round the answer does not need.
   */
  moreRemains: boolean;
  /** The directory the crawl actually rooted at, in forward-slash form. */
  rootDir: string;
  /** The workspace root the `include` was resolved against (an include naming one file roots the crawl at that file). */
  workspaceRoot: string;
  /**
   * The exclusion globs this search did NOT apply, because they would have
   * pruned the search root itself. Carried up rather than swallowed: a search
   * that quietly skips a rule and then says "no matches" tells the model the
   * text is absent when in fact nothing was opened — which is how
   * `include="…/.forge/sessions/*.jsonl"` answered "no matches" for
   * `session_start`, a string every session log begins with.
   */
  skippedExcludes: string[];
}

export async function searchWorkspaceText(
  options: SearchCodeOptions,
  resolution: RipgrepResolution,
  signal?: AbortSignal,
): Promise<SearchCodeFound> {
  signal?.throwIfAborted();
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('No workspace folder open.');

  const { include, maxResults, offset } = options;
  const scope = resolveSearchCodeScope(include, folder.uri.fsPath);
  // Asked once here and again in `rgScopeArgs`, both from the same pure
  // function, so the args ripgrep received and the note the caller is given
  // cannot disagree about which rules were dropped.
  const skippedExcludes = exclusionsCoveringRoot(scope.rootDir).dropped;
  // The page is the files after `offset`, so the crawl has to reach
  // `offset + maxResults` of them before it can stop.
  const pageLimit = offset + maxResults;
  const args = searchCodeRgArgs(options, scope);

  return new Promise<SearchCodeFound>((resolve, reject) => {
    const matches = new Map<string, SearchCodeMatch>();
    let stdoutBuffer = '';
    let stderr = '';
    let settled = false;
    let terminatedEarly = false;
    let moreRemains = false;

    const child = spawn(resolution.command, [...(resolution.argsPrefix ?? []), ...args], {
      cwd: folder.uri.fsPath,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const onAbort = (): void => {
      child.kill();
      finish(new Error('grep_search: cancelled'));
    };

    const finish = (result: SearchCodeFound | Error): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (result instanceof Error) reject(result);
      else
        resolve({
          matches: Array.from(matches.values()),
          moreRemains,
          rootDir: scope.rootDir,
          workspaceRoot: folder.uri.fsPath,
          skippedExcludes,
        });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    const appendEvent = (event: RipgrepEvent): void => {
      const data = isMatchEvent(event) ? event.data : isContextEvent(event) ? event.data : null;
      if (!data) return;

      const filePath = data.path?.text;
      const line = data.lines?.text;
      const lineNumber = data.line_number;
      if (!filePath || line === undefined || lineNumber === undefined) return;

      const normalizedPath = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
      let entry = matches.get(normalizedPath);
      if (!entry) {
        if (matches.size >= pageLimit) {
          // A path the page has no room for: that is the only evidence this
          // crawl is allowed to stop on. Killing at "the page is full" instead
          // — the first line of the last file in the page — cut that file's
          // count short and made `moreRemains` depend on how much of ripgrep's
          // output happened to be in the buffered chunk when the kill landed,
          // so a large tree could report "matched N files in total" for a
          // search that had more files to page to. The last file in the page is
          // now read to its end, and the next file's first line is what ends
          // the crawl.
          moreRemains = true;
          terminatedEarly = true;
          if (!child.killed) child.kill();
          return;
        }
        entry = {
          path: normalizedPath,
          snippets: [],
          snippetMatches: [],
          omittedSnippets: 0,
          matchCount: 0,
        };
        matches.set(normalizedPath, entry);
      }

      const isMatchingLine = isMatchEvent(event);
      if (isMatchingLine) entry.matchCount += 1;
      // The per-file budget is matching lines, not stored lines. A context line
      // rides along with the match it belongs to, and `context: 20` used to spend
      // the whole allowance on context before the first match was reached: the
      // answer was eight context lines, no match at all, and "(+3 more matches in
      // this file)" that read as three extra hits (lab BUG-25).
      if (entry.snippetMatches.filter(Boolean).length >= SNIPPETS_PER_FILE_LIMIT) {
        if (isMatchingLine) entry.omittedSnippets += 1;
        return;
      }
      const marker = event.type === 'match' ? '>' : ' ';
      // Cap before the dedupe check below, so two distinct cuts of the same
      // giant line are still compared as the strings the model will receive.
      const text = capSnippetLine(
        line.replace(/\r?\n$/, ''),
        isMatchEvent(event) ? event.data.submatches?.[0]?.start : undefined,
      );
      const snippet = `${marker} ${lineNumber}: ${text}`;
      if (!entry.snippets.includes(snippet)) {
        entry.snippets.push(snippet);
        entry.snippetMatches.push(isMatchingLine);
      }
    };

    const flushStdout = (): void => {
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          appendEvent(JSON.parse(trimmed) as RipgrepEvent);
        } catch {
          // Ignore malformed rg output and continue parsing subsequent lines.
        }
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      flushStdout();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (err) => {
      const attempted = resolution.candidates.length
        ? resolution.candidates.join(', ')
        : '(VS Code app root unavailable)';
      finish(
        new Error(
          `grep_search: failed to start ripgrep command "${resolution.command}": ${err.message}. ` +
            `Bundled candidates checked: ${attempted}`,
        ),
      );
    });
    child.once('close', (code) => {
      flushStdout();
      if (stdoutBuffer.trim().length > 0) {
        try {
          appendEvent(JSON.parse(stdoutBuffer.trim()) as RipgrepEvent);
        } catch {
          // Ignore malformed trailing output.
        }
      }

      if (settled) return;
      if (terminatedEarly || code === 0 || code === 1) {
        finish({
          matches: Array.from(matches.values()),
          moreRemains,
          rootDir: scope.rootDir,
          workspaceRoot: folder.uri.fsPath,
          skippedExcludes,
        });
        return;
      }

      const detail = stderr.trim() || `ripgrep exited with code ${code}`;
      finish(new Error(`grep_search: ${detail}`));
    });
  });
}
