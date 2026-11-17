/**
 * The HTTP half of the laptop's model-starter traffic (docs/plans/
 * LAPTOP_LAN_ACCESS_PLAN.md Phase 1 step 2): pure functions that turn a
 * `Response`, an HTTP status, or a thrown error into a value, a message, or a
 * yes/no about connectivity.
 *
 * Split out of `RemoteStarterClient.ts` because that file is a state machine
 * (which address to use, which lease is held, when to renew) and these are not.
 * They answer "what did this response say" and "is this failure a dead path",
 * and `RemoteStarterRoute.ts` needs both for its `GET /models` probes just as
 * the client needs them for `POST /ensure` — a second copy of either would be
 * two definitions of what "unreachable" means on a machine that reaches the
 * desktop through `tailscale serve`, where a stopped listener RESETS the
 * connection instead of refusing it.
 *
 * No silent fallback: every message names the address and the cause, because a
 * laptop that quietly used a stale route would fail at the model server
 * instead, where the message says nothing about the desktop.
 */

import { normalizeOpenAiCompatibleBaseUrl } from './CloudProviders';

/** `http://<host>:<port the starter reported>`, same shape as
 *  `getCloudBaseUrl`: origin plus any proxy path, with no trailing `/v1`
 *  (OpenAIClient appends `/v1/chat/completions` itself).
 *
 *  The HOST is the starter that answered, not the one in `endpoint`: at home
 *  the laptop dials the LAN forwarder and away it dials the tailnet address, and
 *  a base URL built on the address that did not answer is a request to a machine
 *  it may not be able to reach. `endpoint`'s scheme, port and any proxy path are
 *  kept, because they are what this window's own OpenAIClient needs; only the
 *  port is replaced, which is the whole point of `/ensure`.
 *
 *  A pass-through entry (`sharedEndpoint`: `<starter>/<desktop model name>`)
 *  keeps the port of the starter that answered instead: its traffic goes
 *  through the starter's own port, and the port `/ensure` reports is the
 *  model's loopback port on the desktop. Swapping it in sent the laptop's chat
 *  to `<desktop>:8091/<model>/v1/chat/completions`, which 404s (third laptop
 *  run, 0.17.191).
 */
export function baseUrlWithPort(
  endpoint: string,
  port: number,
  starter?: string,
  remoteModel?: string,
): string {
  const url = new URL(endpoint);
  if (starter && remoteModel && url.pathname === `/${remoteModel}`) {
    const answered = new URL(starter);
    url.hostname = answered.hostname;
    url.port = answered.port;
    return url.toString().replace(/\/$/, '');
  }
  if (starter) url.hostname = new URL(starter).hostname;
  url.port = String(port);
  return normalizeOpenAiCompatibleBaseUrl(url.toString());
}

/** A JSON object body, read without throwing: a starter that answers with
 *  plain text still has to be reported, not turned into a parse failure. */
export async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text().catch(() => '');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: text.slice(0, 300) };
  }
}

export function textOf(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

/** An HTTP status the starter answered with, already turned into a message. */
export class StarterHttpError extends Error {}

/**
 * The path to a starter is not there — it refused, reset, hung, or never
 * resolved. Typed so the caller can tell "the route is gone, try the next
 * configured address" from "the desktop answered and refused", and so
 * `releaseRemoteStarterLeases` still sees an `Error` on a closing window.
 */
export class StarterUnreachableError extends Error {
  constructor(
    message: string,
    /** Why, as one short phrase (`ECONNRESET`, `timed out after 2.5 s`), for
     *  the message that names every configured address. */
    readonly reason: string,
    /** Whether this failure is a reason to switch addresses. A connect failure
     *  means the route is gone; a 300 s `/ensure` timeout means the desktop is
     *  still working on a cold start and the other address is the same machine,
     *  so re-choosing would only add another 300 s. */
    readonly switchRoute: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * One POST to one starter address, and nothing else: it does not know which
 * addresses exist, never picks one and never tries another — the caller chose
 * the address. `remote` is carried so a status can be turned into a message that
 * names the model the DESKTOP knows, which is what a user has to change if the
 * two configs disagree.
 *
 * Thrown errors are typed by class because the fixes differ: a
 * `StarterHttpError` is an answer from the desktop and must be shown as written;
 * a `StarterUnreachableError` is a dead path, and only the ones whose
 * `switchRoute` is true are worth dialing a different address over. A long
 * timeout means the desktop is still working on a cold start and the other
 * configured address is the same machine, so re-choosing would only add another
 * 300 s to a start that may already be done.
 */
export async function postToStarter(
  fetchImpl: typeof fetch,
  path: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  /** `http://<host>:<starter port>` — the address to dial. */
  starter: string,
  remote: { model: string } | undefined,
  clientLabel: string,
): Promise<Record<string, unknown>> {
  const url = new URL(path, starter).toString();
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  timer.unref?.();
  const forwardAbort = (): void => ctrl.abort();
  if (signal?.aborted) {
    // A signal that is already cancelled has to cut the request before it
    // leaves: `addEventListener` would never fire for it, and the laptop would
    // sit out a 300 s wait for a model the user has stopped asking for.
    ctrl.abort();
  } else {
    signal?.addEventListener('abort', forwardAbort);
  }
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const body = await readJsonObject(response);
    if (!response.ok) {
      throw new StarterHttpError(describeStatus(url, response.status, body, remote, clientLabel));
    }
    return body;
  } catch (error) {
    // A status the starter answered with is already a message; it must not be
    // re-read as a connectivity failure just because the desktop's own error
    // text happens to say "fetch failed".
    if (error instanceof StarterHttpError) throw error;
    // A user Stop is not a connectivity problem: pass it through unchanged so
    // the caller's `signal.aborted` path reports a cancelled turn, not a
    // desktop that is down.
    if (signal?.aborted) throw error;
    if (timedOut || isUnreachable(error)) {
      throw new StarterUnreachableError(
        `Desktop model starter not reachable at ${url}: is a Forge window open on the ` +
          'desktop, and is Tailscale up?',
        timedOut ? `timed out after ${timeoutMs / 1000} s` : failureReasonOf(error),
        isUnreachable(error),
        { cause: error },
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

/**
 * A status the starter answered with, turned into what the laptop should show.
 * Each class gets its own message because each has a different fix: 409 is a
 * wait, 422 is an edit to config.yaml, 404 is a name mismatch between the two
 * machines, 502 is the desktop's own failure and must not be softened.
 */
export function describeStatus(
  url: string,
  status: number,
  body: Record<string, unknown>,
  /** Only `model` is read: the name THE DESKTOP knows, which is what the user
   *  has to change if the two configs disagree. */
  remote: { model: string } | undefined,
  clientLabel: string,
): string {
  const desktopError = textOf(body, 'error');
  const named = remote ? `"${remote.model}"` : 'the model';
  if (status === 409) {
    const busy = Array.isArray(body.busyModel) ? body.busyModel.map(String) : [];
    return (
      `Desktop is busy running ${busy.length ? busy.join(', ') : 'a model'}; try again when its ` +
      `turn ends. (${named}: ${desktopError || 'no busy model named'})`
    );
  }
  if (status === 422) {
    const reason = textOf(body, 'reason') || 'not remotely servable';
    // The fix differs by reason, and since the pass-through landed, "list the
    // port in shared_ports" is only the fix for the one case that still means
    // it: a model with no port to use at all. The others are a kind of model the
    // desktop does not serve from its starter, or a port Forge uses for itself.
    const fixes: Record<string, string> = {
      port_not_shared:
        'Check that its model_starter.shared_ports lists this model\u2019s port in config.yaml on ' +
        'the desktop',
      service_port:
        'A laptop cannot be served a port Forge uses for itself (the control server, the cloud ' +
        'relay, the starter or Ollama\u2019s daemon): the desktop must not point this model at one',
      not_local:
        'The starter serves only its own llama.cpp models and the servers it manages, so this ' +
        'kind of model has to be reached another way',
      ollama_not_shared:
        'Ollama is reached from its own machine\u2019s daemon, never through the starter',
      cli_agent: 'A CLI agent runs where its login is, which is not this starter',
    };
    const fix = fixes[reason] ?? 'The desktop gave no reason for refusing it';
    return (
      `The desktop cannot start ${named} from its model starter (${reason}). ${fix}, ` +
      'and that the Tailscale ACL (away) or the desktop\u2019s LAN firewall rule (at home) ' +
      `lets ${clientLabel} reach it.`
    );
  }
  if (status === 404) {
    return (
      `The desktop config does not name ${named}. remote_start.model must be the name ` +
      `THE DESKTOP uses, not this machine\u2019s. (${desktopError || 'unknown model'})`
    );
  }
  if (status === 502) {
    return `The desktop could not start or load ${named}: ${desktopError || 'no error text'}`;
  }
  return `Desktop model starter (${url}) answered HTTP ${status}: ${desktopError || 'no error text'}`;
}

/**
 * Codes that mean "the path to the desktop is not there", as opposed to "the
 * desktop answered and refused". Through `tailscale serve` a stopped listener
 * RESETS the connection (curl exit 56) instead of refusing it, so both shapes
 * have to read as unreachable — that is the defect the laptop config's missing
 * `unload_path` used to paper over.
 */
export function isUnreachable(error: unknown): boolean {
  const code =
    (error as { code?: string; cause?: { code?: string } })?.code ??
    (error as { cause?: { code?: string } })?.cause?.code;
  if (code && UNREACHABLE_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|socket hang up|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|network unreachable/i.test(
    message,
  );
}

export const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * Why a call to a starter failed, as one short phrase, for a message that names
 * every address: the error's `code` when it has one (`ECONNRESET` — what a user
 * can act on), otherwise its message.
 */
export function failureReasonOf(error: unknown): string {
  const code =
    (error as { code?: string; cause?: { code?: string } })?.code ??
    (error as { cause?: { code?: string } })?.cause?.code;
  if (code) return code;
  return error instanceof Error ? error.message : String(error);
}

/**
 * One GET to the desktop with a deadline, shared by the two reads Connect makes
 * (`GET /models` on the starter, `GET /v1/models` on the cloud relay). It carries
 * the same rules `postToStarter` does, because they are what makes a tailnet
 * failure readable: the deadline is its own `AbortController` so a long
 * generation is never cut by it, an already-cancelled caller signal has to cut
 * the request BEFORE it leaves (`addEventListener` never fires for a signal that
 * is already done), and the caller's cancellation is passed through unchanged so
 * a Stop is reported as a cancelled read rather than as a desktop that is down.
 */
async function getWithDeadline(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  timer.unref?.();
  const forwardAbort = (): void => ctrl.abort();
  if (signal?.aborted) ctrl.abort();
  else signal?.addEventListener('abort', forwardAbort);
  try {
    return await fetchImpl(url, { method: 'GET', signal: ctrl.signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (timedOut || isUnreachable(error)) {
      throw new StarterUnreachableError(
        `The desktop did not answer ${url}: is a Forge window open on the desktop, and is ` +
          'Tailscale up?',
        timedOut ? `timed out after ${timeoutMs / 1000} s` : failureReasonOf(error),
        isUnreachable(error),
        { cause: error },
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

/** What `GET /models` answered: the desktop's model rows, and the shared port
 *  the pass-through serves model traffic on (`null` from a desktop build that
 *  predates the pass-through, which is what tells Connect it has to write the
 *  old direct-port shape). */
export interface StarterModelList {
  models: Array<Record<string, unknown>>;
  sharedPort: number | null;
}

/**
 * `GET <starter>/models` — read-only: it starts nothing, loads nothing and takes
 * no lease, which is what lets this run against a sleeping desktop. The same
 * `Host`/`Origin`/content-type guards the starter applies to every route apply
 * here, and a 403 comes back as its own text because it names the fix.
 *
 * An address that answers 200 without a `models` array is reported as "not a
 * Forge model starter" — the same rule `RemoteStarterRoute`'s probe uses, so a
 * router or a port forwarder holding the desktop's address cannot pass for it.
 */
export async function listStarterModels(
  fetchImpl: typeof fetch,
  starter: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<StarterModelList> {
  const url = new URL('/models', starter).toString();
  const response = await getWithDeadline(fetchImpl, url, timeoutMs, signal);
  const body = await readJsonObject(response);
  if (!response.ok) {
    throw new StarterHttpError(describeStatus(url, response.status, body, undefined, 'connect'));
  }
  if (!Array.isArray(body.models)) {
    throw new StarterHttpError(
      `${url} answered 200 without a "models" list: not a Forge model starter`,
    );
  }
  const shared = Number(body.shared_port);
  return {
    models: body.models.filter((row) => row && typeof row === 'object') as Array<
      Record<string, unknown>
    >,
    sharedPort: Number.isInteger(shared) && shared > 0 && shared <= 65535 ? shared : null,
  };
}

/** One cloud model the desktop relay is willing to serve. `kind` is what the
 *  relay reports: `ollama` for its Ollama cloud entries, `openai` for the keyed
 *  providers, and it decides which GROUP the laptop entry goes in. */
export interface RelayModelRow {
  id: string;
  kind: string;
}

/**
 * `GET <relay>/v1/models` — the relay's allowlist, in the OpenAI list shape the
 * relay already answers with. Read-only, and no key crosses in either direction:
 * the relay resolves the token on the desktop, so this read tells the laptop
 * which names it may write, nothing more.
 */
export async function listRelayModels(
  fetchImpl: typeof fetch,
  relay: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<RelayModelRow[]> {
  const url = new URL('/v1/models', relay).toString();
  const response = await getWithDeadline(fetchImpl, url, timeoutMs, signal);
  const body = await readJsonObject(response);
  if (!response.ok) {
    throw new StarterHttpError(
      `${url} answered HTTP ${response.status}: ${textOf(body, 'error') || 'no error text'}`,
    );
  }
  const data = Array.isArray(body.data) ? body.data : null;
  if (!data) {
    throw new StarterHttpError(
      `${url} answered 200 without a "data" list: not a Forge cloud relay`,
    );
  }
  return data
    .map((row) => (row && typeof row === 'object' ? (row as Record<string, unknown>) : null))
    .filter((row): row is Record<string, unknown> => row !== null)
    .map((row) => ({
      id: typeof row.id === 'string' ? row.id : '',
      kind:
        typeof row.owned_by === 'string' && row.owned_by === 'forge-relay'
          ? typeof row.kind === 'string'
            ? row.kind
            : 'openai'
          : 'openai',
    }))
    .filter((row) => row.id.trim().length > 0);
}
