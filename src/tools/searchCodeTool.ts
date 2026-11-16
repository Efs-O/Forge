/**
 * `grep_search`: what the caller asked for, what the secret gate allows, and
 * what the result says. The ripgrep crawl itself is `searchCodeCrawl.ts`.
 *
 * Split out of `dirTools.ts` because search reads file *contents*. A hit in
 * `.env` prints a secret into the transcript without ever asking for one, so
 * this file owns the drop-and-count rule: `secretPaths.ts` decides what is a
 * secret, this file applies it to what ripgrep found. `find_files` names files
 * without reading them, so it has no such rule and stays in `dirTools.ts`.
 *
 * The three `output` modes share one crawl (item 1.1, 2026-10-29): `files` and
 * `count` keep less of what the crawl already reports, rather than running
 * `rg -l` / `rg -c`. Real ripgrep answers `--json -l` and `--json -c` as plain
 * text, not JSON, so those modes would have needed a second parser and a second
 * secret-gate path — and the gate is the part that must not fork.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';
import type { ForgeConfig } from '../config/types';
import { secretPatternForArgument, secretPatternForTaint } from './secretPaths';
import { markConversationReadSecret } from './exfilTaint';
import { resolveWorkspacePath } from '../util/WorkspacePaths';
import { DEFAULT_TOOL_OUTPUT_LIMITS } from './toolOutputLimits';
import { isGlobInclude, SEARCH_EXCLUDES } from './searchScope';
import {
  renderSearchCodeCounts,
  renderSearchCodeMatches,
  renderSearchCodePaths,
  type SearchCodeMatch,
  type SearchCodeOutputMode,
} from './searchCodeOutput';
import { searchWorkspaceText, type SearchCodeFound } from './searchCodeCrawl';
import { resolveRipgrep, type RipgrepResolution } from './RipgrepResolver';
import { capResultText } from './resultCap';
import { MAX_SEARCH_RESULT_CHARS } from './searchSnippet';
import { missingIncludeNote } from './dirTools';

export { SNIPPETS_PER_FILE_LIMIT } from './searchCodeCrawl';

/** What `context` is when the caller does not name one: two lines, as it always was. */
const DEFAULT_CONTEXT_LINES = 2;
/**
 * The most context this tool will carry, so one call cannot ask for a whole file.
 *
 * Outside this range the value is CLAMPED here, not refused: the schema declares no
 * `minimum`/`maximum` for `context` on purpose. A model that wants forty lines of
 * context is not wrong about what it wants, only about how much this tool carries,
 * and refusing made it spend a round re-sending the same search. 20 refused calls in
 * 10 days of session logs; the largest ask was 30 lines.
 */
const MAX_CONTEXT_LINES = 30;

/**
 * The call's numbers, inside the range the schema declares.
 *
 * The shared validator (`ToolRegistry.invalidArgs`) refuses an out-of-range integer
 * only where the schema declares `minimum`/`maximum`. `context` declares neither, so
 * `context: 400` reaches here and is clamped; `max_results` keeps its declared bounds
 * and its refusal, which is the right answer there — asking for five hundred results
 * is a mistake the caller should see, not one quietly rewritten.
 */
function boundedInt(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

/**
 * When the caller asked for more context than this tool carries, or less than none,
 * the result names the number it actually got, instead of quietly answering a
 * different question than the one that was asked.
 */
function contextClampNote(requested: unknown, used: number): string | undefined {
  if (requested === undefined) return undefined;
  const parsed = typeof requested === 'number' ? requested : Number(requested);
  if (!Number.isFinite(parsed)) return undefined;
  const asked = Math.trunc(parsed);
  if (asked >= 0 && asked <= MAX_CONTEXT_LINES) return undefined;
  return (
    `context: asked for ${asked} lines; this tool carries 0-${MAX_CONTEXT_LINES}, ` +
    `so each match shows ${used}.`
  );
}

/** A wrong `output` is refused here, not by `invalidArgs`: that checks types, not enums. */
function outputModeOf(value: unknown): SearchCodeOutputMode {
  if (value === undefined || value === 'content') return 'content';
  if (value === 'files' || value === 'count') return value;
  throw new Error(
    `grep_search: output must be "content", "files" or "count", not ${JSON.stringify(value)}.`,
  );
}

/**
 * True when the query can only match across a line break, so ripgrep would
 * reject it before reading a single file.
 *
 * Measured 2026-11-16 against the ripgrep this tool ships: a real newline in the
 * pattern is refused even with `-F`, and `\n` in a regex is refused too — only
 * `-U` (multiline) accepts either, and this tool does not run that, because
 * multiline mode changes what every other pattern in the same call means. The
 * two-character sequence `\n` with `literal: true` is ordinary text and passes.
 */
function spansLines(query: string, literal: boolean): boolean {
  if (/[\r\n]/u.test(query)) return true;
  if (literal) return false;
  return /\\n/u.test(query.replace(/\\\\/gu, ''));
}

export function makeSearchCodeTool(
  resolveCommand: () => RipgrepResolution = () => resolveRipgrep(vscode.env.appRoot),
  deps: {
    getConfig?: () => ForgeConfig;
    home?: string;
    platform?: NodeJS.Platform;
  } = {},
): RegisteredTool {
  /** Is this search hit a file the secret gate owns? Search prints lines, so a
   *  hit in `.env` would leak a secret without ever asking — the plan drops the
   *  lines and says how many there were, rather than asking on every search. */
  const secretPatternOf = (candidate: string): string | undefined =>
    secretPatternForArgument(candidate, deps.getConfig?.(), resolveWorkspacePath, deps);
  /** The taint question, with nothing allow-listed: a path the owner put in
   *  `permissions.secret_paths_allow` gets no card, but its lines still count as
   *  a secret read once search prints them into this chat. */
  const secretTaintOf = (candidate: string): string | undefined =>
    secretPatternForTaint(candidate, deps.getConfig?.(), resolveWorkspacePath, deps);
  return {
    definition: {
      type: 'function',
      function: {
        name: 'grep_search',
        description:
          'Search for a ripgrep regex by default, or plain text when literal is true, across ' +
          'workspace files or a named absolute path, folder or glob outside the workspace. ' +
          'Relative includes are rooted at the workspace; absolute globs at the path before the ' +
          'first wildcard. output:"files" lists paths only, "count" gives per-file counts, ' +
          '"content" (default) shows match lines with context. Set include_ignored to search ' +
          'gitignored files. A result that could not show every matching file names the offset ' +
          'to call next. Ripgrep regex does not support lookaround or backreferences.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Text or ripgrep regex to search for.' },
            literal: {
              type: 'boolean',
              description: 'Match the query as plain text (default false: ripgrep regex).',
            },
            include: {
              type: 'string',
              description:
                'Glob of files to include, e.g. "**/*.ts" (default "**/*"), anchored at the ' +
                'workspace root. An absolute path, folder or glob can target outside it.',
            },
            output: {
              type: 'string',
              enum: ['content', 'files', 'count'],
              description:
                '"content" (default) prints match lines; "files" prints paths only (cheaper — ' +
                'where to look next is usually the whole question); "count" prints ' +
                'path:matches per file.',
            },
            context: {
              type: 'integer',
              description:
                `Lines of context around each match (0-${MAX_CONTEXT_LINES}, default ` +
                `${DEFAULT_CONTEXT_LINES}). More is clamped to ${MAX_CONTEXT_LINES} and said ` +
                'in the result; below 0 becomes 0. Ignored by output "files" and "count".',
            },
            ignore_case: {
              type: 'boolean',
              description: 'Match the query case-insensitively (default false).',
            },
            include_ignored: {
              type: 'boolean',
              description:
                "Also search files the workspace .gitignore excludes (default false). A broad glob such as **/* can already reach them; set this to be sure. The tool's own exclusions (.git, node_modules, dist, out, Forge's embeddings index, session logs, remote inbox) still apply.",
            },
            max_results: {
              type: 'integer',
              description:
                'Max matching FILES to return (default 20) in every output mode. The result ' +
                'says when more files matched than it showed.',
            },
            offset: {
              type: 'integer',
              minimum: 0,
              description:
                'Skip this many matching files to page past max_results; use the offset the ' +
                'previous result named.',
            },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args, context) => {
      // A single trailing line break is how a model writes a pattern it copied
      // out of a heredoc, not part of the search: dropping it is lossless, and
      // keeping it would refuse a query that means what it says. A query that is
      // nothing but a line break keeps it, so the refusal still says why.
      const strippedQuery = (args['query'] as string).replace(/\r?\n$/u, '');
      const query = strippedQuery.length > 0 ? strippedQuery : (args['query'] as string);
      const literal = args['literal'] === true;
      const include = (args['include'] as string | undefined) ?? '**/*';
      const maxResults = boundedInt(args['max_results'], 20, 1, 200);
      const offset = boundedInt(args['offset'], 0, 0, 1_000_000);
      const output = outputModeOf(args['output']);
      const contextLines = boundedInt(args['context'], DEFAULT_CONTEXT_LINES, 0, MAX_CONTEXT_LINES);
      const contextNote = contextClampNote(args['context'], contextLines);
      const ignoreCase = args['ignore_case'] === true;
      const includeIgnored = args['include_ignored'] === true;

      // Say it here rather than handing back ripgrep's own complaint about a
      // pattern it never ran: the model reads `the literal "\n" is not allowed
      // in a regex` as a fault in the tool, and retries the same pattern.
      if (spansLines(query, literal)) {
        return (
          'Error: grep_search: the query spans lines, and this tool does not run ripgrep in ' +
          'multiline mode. Nothing ran. Search one line of the pattern, or split it into two ' +
          'searches, or keep the text on one line with literal: true.'
        );
      }

      let found: SearchCodeFound;
      try {
        found = await searchWorkspaceText(
          {
            query,
            literal,
            include,
            maxResults,
            offset,
            output,
            context: contextLines,
            ignoreCase,
            includeIgnored,
          },
          resolveCommand(),
          context?.abortSignal,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/regex parse error/iu.test(message)) {
          return `${message}\nEscape the special characters, or retry with literal: true.`;
        }
        throw error;
      }
      const { matches: crawled, moreRemains, rootDir, workspaceRoot, skippedExcludes } = found;
      /**
       * What this search did NOT look at, said in the order the caller needs it.
       *
       * A search that opened nothing has to say why, or its "no matches" reads as
       * "this text is not in the tree": the tool's own noise list prunes
       * `.forge/sessions/`, and a search rooted inside that folder answered
       * "no matches" for `session_start`, which every session log begins with —
       * an agent that believed it stopped looking for logs it had not opened.
       * Three causes, three sentences: a rule the tool dropped because it would
       * have pruned the root (nothing was skipped, and the caller should know the
       * rule was dropped), an `include` that named a path that is not there, and
       * a glob that skips gitignored files.
       */
      const skipNotes: string[] = [];
      if (crawled.length === 0 && skippedExcludes.length > 0) {
        skipNotes.push(
          `[Note: this search DROPPED the tool's own exclusions ` +
            `${skippedExcludes.map((glob) => `\`${glob}\``).join(', ')}, because the folder it was ` +
            `rooted at (${rootDir}) is inside them — applied, they would have pruned the folder the ` +
            `caller named and left nothing to open. Everything under that folder was searched, so ` +
            `this miss is real.]`,
        );
      }
      if (crawled.length === 0) {
        // Against the workspace root, as the scope resolver judged it: an include
        // naming one existing file roots the crawl AT that file, so resolving the
        // include against rootDir doubled the path and reported a real file missing.
        const includeNote = missingIncludeNote(include, workspaceRoot);
        if (includeNote) skipNotes.push(`[${includeNote.trimStart()}]`);
        else if (isGlobInclude(include)) {
          const excludes = SEARCH_EXCLUDES.map((glob) => '`' + glob + '`').join(', ');
          const toolExcludes = `The tool ${includeIgnored ? 'still' : 'also'} keeps ${excludes} out of a crawl — name the file or folder in full in \`include\` to search inside one.`;
          skipNotes.push(
            includeIgnored
              ? ` Gitignored files were searched. ${toolExcludes}`
              : ` A glob can skip gitignored files; set include_ignored: true to search them. ${toolExcludes}`,
          );
        }
        const mode = literal ? 'plain-text' : 'ripgrep-regex';
        const scopeNote = path.isAbsolute(include)
          ? ' (absolute include paths are searched from their named path)'
          : ' (relative include globs are anchored at the workspace root)';
        return (
          `No matches found for "${query}" in ${include} ` +
          `(${mode} search${scopeNote}).` +
          skipNotes.filter(Boolean).join(' ')
        );
      }
      // `offset` pages by FILE, so it is applied to everything ripgrep reported
      // before the secret gate removes any: a page is the same set of files
      // whatever the gate does to it, and an offset that shifted with the number
      // of secret files would make the next page different every time.
      const page = offset > 0 ? crawled.slice(offset) : crawled;
      if (page.length === 0) {
        const lastPage = Math.max(0, crawled.length - maxResults);
        return (
          `[offset ${offset} is past the end: "${query}" matched ${crawled.length} file${
            crawled.length === 1 ? '' : 's'
          } in total, so the last page starts at offset ${lastPage}. Lower the offset, ` +
          'or narrow the include glob.]'
        );
      }

      const hidden: { path: string; lines: number; pattern: string }[] = [];
      const kept: SearchCodeMatch[] = [];
      let printedSecret: { path: string; pattern: string } | undefined;
      for (const match of page) {
        const pattern = secretPatternOf(match.path);
        if (!pattern) {
          kept.push(match);
          // Not a secret at all, or a secret the owner allowed: only the second
          // one put lines of a secret file into this chat's context, and that
          // one is what the fetch gate has to remember.
          const taint = secretTaintOf(match.path);
          if (taint && !printedSecret) printedSecret = { path: match.path, pattern: taint };
          continue;
        }
        hidden.push({ path: match.path, lines: match.matchCount, pattern });
      }
      // A dropped hit taints nothing: its lines never reached the chat. Lines
      // from an allow-listed `.env` did, so the chat is marked for its next
      // fetch exactly as it would have been had the read gone through `read_file`.
      if (printedSecret)
        markConversationReadSecret(
          context?.conversationId,
          printedSecret.pattern,
          printedSecret.path,
        );
      const hiddenNote = hidden.length
        ? `${hidden.reduce((total, file) => total + file.lines, 0)} matching lines in ${
            hidden.length
          } secret file${hidden.length === 1 ? '' : 's'} (${hidden
            .map((file) => `\`${file.path}\` matched ${file.pattern}`)
            .join(
              '; ',
            )}) were hidden — search prints lines, and a secret read by search is a secret read. ` +
          'Read the file with read_file to ask the user, or narrow the search with an include glob.'
        : '';
      /**
       * The one line that says whether what the caller has is everything.
       *
       * `max_results` stops the crawl at the file limit, so a result of twenty
       * files used to read the same whether forty more matched or none did — an
       * agent that assumed "twenty" meant "all" stopped looking and reported
       * absence for something present. The note names the offset that continues
       * this search, so paging is one call rather than a re-search with a
       * guessed glob. When the crawl saw every file and the caller paged, the
       * note says so, or the model keeps asking for pages that do not exist.
       */
      const pagingNote = moreRemains
        ? `${kept.length} matching file${kept.length === 1 ? '' : 's'} shown${
            offset > 0 ? `, the first ${offset} skipped` : ''
          }; more matching files exist beyond this page — call again with offset ${
            offset + maxResults
          } to see the next ${maxResults}, or narrow the include glob.`
        : offset > 0
          ? `That is the last page: "${query}" matched ${crawled.length} file${
              crawled.length === 1 ? '' : 's'
            } in total, and this call skipped the first ${offset}.`
          : '';

      if (kept.length === 0) {
        return (
          `No matches outside secret paths for "${query}" in ${include}.` +
          `\n[${[hiddenNote, pagingNote].filter(Boolean).join(' ')}]`
        );
      }

      const lineLimit =
        context?.outputLimits?.searchLines ?? DEFAULT_TOOL_OUTPUT_LIMITS.searchLines;
      const body =
        output === 'files'
          ? renderSearchCodePaths(kept, lineLimit)
          : output === 'count'
            ? renderSearchCodeCounts(kept, lineLimit)
            : renderSearchCodeMatches(kept, lineLimit);

      return capResultText(
        [
          body,
          ...(contextNote ? [`[${contextNote}]`] : []),
          ...(pagingNote ? [`[${pagingNote}]`] : []),
          ...(hiddenNote ? [`[Note: ${hiddenNote}]`] : []),
        ].join('\n'),
        MAX_SEARCH_RESULT_CHARS,
        'grep_search',
        'Narrow the search with a more specific query or an `include` glob.',
      );
    },
  };
}
