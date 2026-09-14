import type * as vscode from 'vscode';
import type { ImageBackendConfig } from '../../config/types';
import { resolveCloudRequestTarget } from '../../llm/CloudRequestResolver';
import { mimeFromHeader } from '../imageTool';

/** Generous: a 2k render from a busy provider has been seen past a minute. */
const GENERATION_TIMEOUT_MS = 180_000;
/** Above any real single render; stops a misbehaving URL filling the disk. */
export const MAX_GENERATED_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_ERROR_BODY_CHARS = 400;

export interface GeneratedImage {
  bytes: Buffer;
  mime: string;
  /** The provider's rewritten prompt, when it returns one (OpenAI does). */
  revisedPrompt?: string;
}

export interface CloudImageRequest {
  backend: ImageBackendConfig;
  prompt: string;
  secrets: vscode.SecretStorage | undefined;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

interface ImagesResponse {
  data?: { url?: string; b64_json?: string; revised_prompt?: string }[];
}

/**
 * One image from an OpenAI-style `POST /v1/images/generations`.
 *
 * `response_format` is not sent: gpt-image models reject it (they only return
 * base64) while xAI returns a URL by default, so both shapes are accepted on
 * the way back instead. A URL is fetched immediately — providers serve these
 * from short-lived temporary storage.
 */
export async function generateCloudImage(request: CloudImageRequest): Promise<GeneratedImage> {
  const { backend, prompt } = request;
  const fetchImpl = request.fetchImpl ?? fetch;
  const signal = withTimeout(request.signal);
  // The same resolver chat uses, so a backend authenticates exactly like a
  // chat model on the same provider -- xAI's OpenCode OAuth refresh included.
  const { baseUrl, apiKey } = await resolveCloudRequestTarget(
    {
      name: `image backend "${backend.name}"`,
      provider: backend.provider,
      ...(backend.api_key_secret ? { api_key_secret: backend.api_key_secret } : {}),
      ...(backend.endpoint ? { endpoint: backend.endpoint } : {}),
    },
    request.secrets,
  );

  const response = await fetchImpl(`${baseUrl}/v1/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: backend.model, prompt, n: 1 }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await describeHttpFailure(backend, response));
  }

  const body = (await response.json()) as ImagesResponse;
  const first = body.data?.[0];
  let bytes: Buffer;
  if (first?.b64_json) {
    bytes = Buffer.from(first.b64_json, 'base64');
  } else if (first?.url) {
    bytes = await downloadImage(first.url, fetchImpl, signal);
  } else {
    throw new Error(
      `${backend.name}: the provider answered 200 but returned no image (no url or b64_json).`,
    );
  }

  if (bytes.length > MAX_GENERATED_IMAGE_BYTES) {
    throw new Error(
      `${backend.name}: image is ${bytes.length.toLocaleString()} bytes, over the cap.`,
    );
  }
  const mime = mimeFromHeader(bytes);
  if (!mime) {
    throw new Error(
      `${backend.name}: the returned data is not a PNG, JPEG, GIF, BMP or WebP image.`,
    );
  }
  return { bytes, mime, ...(first.revised_prompt ? { revisedPrompt: first.revised_prompt } : {}) };
}

async function downloadImage(
  url: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<Buffer> {
  if (!url.toLowerCase().startsWith('https://')) {
    throw new Error(`image URL is not https, refusing to fetch it: ${url.slice(0, 80)}`);
  }
  const response = await fetchImpl(url, { signal });
  if (!response.ok) {
    throw new Error(
      `the image was generated but its download failed (HTTP ${response.status}); the temporary URL may have expired.`,
    );
  }
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_GENERATED_IMAGE_BYTES) {
    throw new Error(`image download is ${declared.toLocaleString()} bytes, over the cap.`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function describeHttpFailure(
  backend: ImageBackendConfig,
  response: Response,
): Promise<string> {
  const detail = (await response.text().catch(() => '')).slice(0, MAX_ERROR_BODY_CHARS);
  const prefix = `${backend.name}: HTTP ${response.status}${detail ? `: ${detail}` : ''}`;
  if (response.status === 401 || response.status === 403) {
    const fix =
      backend.provider === 'xai'
        ? 'Run "opencode auth login" and pick xAI, or set an API key with "Forge: Set Cloud Provider Token".'
        : `Set the key with "Forge: Set Cloud Provider Token" (key: ${backend.api_key_secret ?? 'unset'}).`;
    return `${prefix} — the provider rejected the credentials. ${fix}`;
  }
  if (response.status === 404 || response.status === 400) {
    return `${prefix} — check that model "${backend.model}" is an image-generation model this account can use.`;
  }
  if (response.status === 429) {
    return `${prefix} — rate limited or out of credit. Wait, or pick another backend.`;
  }
  return prefix;
}

function withTimeout(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(GENERATION_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
