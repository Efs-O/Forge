/**
 * The one boundary a tool puts around text that came from outside this chat.
 *
 * Two tools used to write their own copy of the markers, and both interpolated
 * the caller's text unchanged: content carrying its own `</UNTRUSTED_CONTENT>`
 * could close the block early and let everything after it read as Forge's own
 * words. `web_fetch` had already learned that the hard way, so the stripping and
 * the shape now live here, once.
 */
const MARKER = /<\/?\s*UNTRUSTED_CONTENT\s*>/giu;

/**
 * Defuse the wrapper's own markers in text that has to be shown INSIDE the
 * fence. A caller-supplied phrase — `web_fetch`'s `find`, which the result
 * echoes back — is not outside content, but a closing marker inside it still
 * ends the block early, so it is stripped before it is printed.
 */
export function defuseMarkers(text: string): string {
  return text.replace(MARKER, '[marker removed]');
}

/**
 * `whatItIs` says in one line what the block is — the model needs the source of
 * the text, not just the fact that it is fenced.
 */
export function wrapUntrusted(body: string, whatItIs: string): string {
  return (
    '<UNTRUSTED_CONTENT>\n' +
    `${defuseMarkers(whatItIs)}\n` +
    `${defuseMarkers(body)}\n` +
    '</UNTRUSTED_CONTENT>'
  );
}
