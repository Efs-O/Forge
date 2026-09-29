import { Agent, fetch as undiciFetch } from 'undici';

/**
 * How long a local llama-server request may wait for response headers.
 *
 * llama-server sends no headers until the request's first result exists, so a
 * request queued behind another chat on a busy slot, or prefilling a long
 * prompt, waits with none. The extension host's built-in fetch gives up on that
 * after undici's default 300 s and offers no option to change it; this module
 * uses the undici package's own fetch so the limit can be set.
 * See docs/plans/LOCAL_QUEUE_WAIT_PLAN.md.
 */
export const LOCAL_HEADERS_TIMEOUT_MS = 30 * 60_000;

let agent: Agent | undefined;

/** fetch for local llama.cpp chat requests; one Agent is shared by all of them. */
export function localLlamaFetch(url: string, init: RequestInit): Promise<Response> {
  agent ??= new Agent({ headersTimeout: LOCAL_HEADERS_TIMEOUT_MS });
  // undici types its RequestInit/Response separately from the DOM lib's; at
  // runtime they are the same web-standard shapes Node's own fetch uses.
  return undiciFetch(url, {
    ...(init as unknown as Parameters<typeof undiciFetch>[1]),
    dispatcher: agent,
  }) as unknown as Promise<Response>;
}

/** Closes the shared Agent's sockets on deactivation. */
export async function disposeLocalLlamaFetch(): Promise<void> {
  const current = agent;
  agent = undefined;
  await current?.close();
}
