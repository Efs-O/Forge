/**
 * Temporary public hosting for a local image, so a URL-only search provider
 * can fetch it. Litterbox (catbox.moe's temporary tier) needs no key and deletes
 * the file itself after the requested lifetime; it has no delete API.
 *
 * Litterbox does NOT validate content — an HTML page named `.jpg` uploads fine
 * (seen live 2026-09-15) — so the caller must sniff magic bytes first.
 */

export const LITTERBOX_ENDPOINT = 'https://litterbox.catbox.moe/resources/internals/api.php';
/** Lifetime requested per upload. Callers cache the URL for less than this. */
export const LITTERBOX_LIFETIME = '1h';

const LITTERBOX_URL = /^https:\/\/litter\.catbox\.moe\/\S+$/u;

export interface LitterboxUploadRequest {
  bytes: Uint8Array;
  filename: string;
  mime: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export async function uploadTemporaryImage(request: LitterboxUploadRequest): Promise<string> {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('time', LITTERBOX_LIFETIME);
  form.append('fileToUpload', new Blob([request.bytes], { type: request.mime }), request.filename);

  const response = await (request.fetchImpl ?? fetch)(LITTERBOX_ENDPOINT, {
    method: 'POST',
    body: form,
    ...(request.signal ? { signal: request.signal } : {}),
  });
  // The success body is the bare URL as text; failures are text or HTML.
  const body = (await response.text()).trim();
  if (!response.ok) {
    throw new Error(`Litterbox upload failed: HTTP ${response.status} — ${body.slice(0, 200)}`);
  }
  if (!LITTERBOX_URL.test(body)) {
    throw new Error(`Litterbox upload returned no file URL: ${body.slice(0, 200)}`);
  }
  return body;
}
