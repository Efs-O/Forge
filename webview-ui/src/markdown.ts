/**
 * Repairs a common streamed-output Markdown defect without changing the saved
 * message: a fenced block opener attached directly to prose is not a block in
 * CommonMark, so ReactMarkdown renders it as inline code instead.
 */
export function normalizeMarkdownForRender(content: string): string {
  return content.replace(/([^\r\n])(```[A-Za-z0-9_-]*(?:\r?\n|$))/g, '$1\n\n$2');
}
