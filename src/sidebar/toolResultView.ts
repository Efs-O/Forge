/**
 * How a finished tool call is labelled in the transcript. Kept out of
 * ToolDispatch so the presentation rule has one owner and can be tested without
 * the VS Code surface.
 */

/** Tools whose result is noise — the argument is the interesting part. */
export const READ_ONLY_TOOLS = new Set([
  'read_file',
  'list_directory',
  'search_code',
  'get_diagnostics',
]);

export function readPathArg(args?: Record<string, unknown>): string | null {
  if (typeof args?.['path'] === 'string') return args['path'];
  if (typeof args?.['filepath'] === 'string') return args['filepath'];
  return null;
}

/** True for a result the tool layer reports as a failure or a refusal. */
export function isFailureResult(result: string): boolean {
  return result.startsWith('Error:') || result.startsWith('User declined:');
}

/**
 * One-line row label. The full result stays available behind the row's toggle,
 * so this only has to identify the call, never summarise it.
 */
export function resultLabel(toolName: string, result: string, pathArg: string | null): string {
  if (READ_ONLY_TOOLS.has(toolName) && pathArg) return pathArg;
  const firstLine = result.split(/\r?\n/, 1)[0] ?? '';
  const cleaned = firstLine.replace(/\[(file|dir|staged)\]\s*/g, '').trim();
  return cleaned.length > 120 ? `${cleaned.slice(0, 120)}…` : cleaned;
}

/**
 * Tools whose result is prose and should render as Markdown in the transcript.
 * Everything else is verbatim text — file contents, command output, diffs — and
 * rendering those as Markdown misreads them: a `# comment` line in a YAML file
 * became an H1 at the browser's default 2em, which is how a config.yaml read
 * exploded to banner size inside a 12px tool row.
 */
export const PROSE_RESULT_TOOLS = new Set([
  'ask_local_agent',
  'ask_user',
  'web_search',
  'web_fetch',
  'recall',
  'list_memories',
]);

/** True when a finished tool's result should render as Markdown, not verbatim. */
export function rendersAsMarkdown(toolName: string): boolean {
  return PROSE_RESULT_TOOLS.has(toolName);
}
