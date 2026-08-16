/**
 * Render-time linkification. The saved message text is never changed — the same
 * contract `normalizeMarkdownForRender` follows — so a transcript round-trips
 * unaltered through persistence.
 */

/**
 * Extensions a bare token must end in to be treated as a file path. The list is
 * the guard that keeps prose like `and/or`, `24/7` or `TCP/IP` out: a slash
 * alone is far too common in English to be a signal.
 */
const PATH_EXTENSIONS = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'jsonc',
  'py',
  'rs',
  'go',
  'java',
  'kt',
  'rb',
  'php',
  'cs',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'sh',
  'bash',
  'ps1',
  'psm1',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'md',
  'mdx',
  'txt',
  'css',
  'scss',
  'html',
  'htm',
  'xml',
  'sql',
  'vue',
  'svelte',
  'gguf',
  'vsix',
  'lock',
] as const;

const EXT_GROUP = PATH_EXTENSIONS.join('|');

/**
 * A path-shaped token: at least one separator, a filename, one of the known
 * extensions, and an optional `:42` (or `:42:7`) line suffix. Anchored on
 * whitespace or common punctuation so it never fires inside a longer word.
 */
const PATH_PATTERN = new RegExp(
  String.raw`(^|[\s(\[<"'` +
    '`' +
    String.raw`])((?:\.{1,2}[\\/])?(?:[\w.@~-]+[\\/])+[\w.@-]+\.(?:${EXT_GROUP})(?::\d+(?::\d+)?)?)(?=$|[\s)\]>,;:."'` +
    '`' +
    String.raw`]|:(?!\d))`,
  'gi',
);

const BARE_URL_PATTERN = /(^|[\s([<])(https?:\/\/[^\s)\]<>"'`]+[^\s)\]<>"'`.,;:!?])/gi;

export const FILE_LINK_SCHEME = 'forge-file://';

export interface ParsedFileLink {
  path: string;
  line?: number;
}

/** Splits a `forge-file://` href back into its path and optional line. */
export function parseFileLink(href: string): ParsedFileLink {
  const raw = decodeURIComponent(href.slice(FILE_LINK_SCHEME.length));
  const match = /^(.*?):(\d+)(?::\d+)?$/.exec(raw);
  if (!match) return { path: raw };
  return { path: match[1]!, line: Number(match[2]) };
}

/**
 * Marks up bare file paths and URLs as Markdown links. Anything already inside a
 * fenced block, an inline-code span, or an existing Markdown link is left alone —
 * a path inside a code sample is content, not navigation.
 */
export function linkifyForRender(content: string): string {
  return mapUnprotectedSegments(content, (segment) =>
    segment
      .replace(BARE_URL_PATTERN, (_m, lead: string, url: string) => `${lead}[${url}](${url})`)
      .replace(
        PATH_PATTERN,
        (_m, lead: string, target: string) =>
          `${lead}[${target}](${FILE_LINK_SCHEME}${encodeURIComponent(target)})`,
      ),
  );
}

/**
 * Applies `transform` to the parts of `content` that are plain prose, skipping
 * fenced code blocks, inline code spans and existing Markdown links.
 */
function mapUnprotectedSegments(content: string, transform: (text: string) => string): string {
  // Fenced blocks first — an inline-code or link pattern inside a fence is code.
  const protectedPattern = /```[\s\S]*?(?:```|$)|`[^`\n]*`|\[[^\]\n]*\]\([^)\n]*\)/g;
  let out = '';
  let last = 0;
  for (const match of content.matchAll(protectedPattern)) {
    const start = match.index;
    out += transform(content.slice(last, start)) + match[0];
    last = start + match[0].length;
  }
  return out + transform(content.slice(last));
}
