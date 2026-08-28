/**
 * Classifier for "this backend has no vision projector", the sibling of
 * `isTruncationParseError`: both arrive as an HTTP 500 from the same
 * llama-server, and both are unactionable until the body is read.
 *
 * Unlike truncation there is nothing to retry — the request can never succeed
 * against this model — so the result is a plain typed message, not a recovery.
 */

/** llama-server: `image input is not supported - hint: … provide the mmproj`. */
const IMAGE_UNSUPPORTED_MARKER = 'image input is not supported';

export function isImageUnsupportedError(message: string): boolean {
  return message.toLowerCase().includes(IMAGE_UNSUPPORTED_MARKER);
}

/**
 * `httpStatus` is optional because the two call sites genuinely differ: a non-2xx
 * response has a real status to report, while a streamed SSE `error` frame
 * arrives on an already-200 stream and carries no status of its own. Inventing
 * one for the stream would report a fictional HTTP code on every streamed
 * failure; omitting it everywhere would throw away real information on the
 * response path.
 */
export function imageUnsupportedMessage(modelName: string, httpStatus?: number): string {
  return (
    `Model "${modelName}" rejected an image: it has no vision projector. ` +
    'Set mmproj_path (llama.cpp) or remove the vision capability.' +
    (httpStatus === undefined ? '' : ` (HTTP ${httpStatus})`)
  );
}
