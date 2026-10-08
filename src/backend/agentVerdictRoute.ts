import type * as http from 'http';
import type { BusPaths } from '../agentBus/agentBus';
import { acknowledgeVerdict, readVerdictArtifact } from '../agentMesh/verdictArtifact';
import { sendJson } from './controlHttp';
import { agentSenderSchema } from '../agentLinks/chatAgentLinks';

export interface VerdictRouteDeps {
  paths: () => BusPaths;
  validateFrom?: (
    from: string,
  ) =>
    | { ok: true }
    | { ok: false; error: string }
    | Promise<{ ok: true } | { ok: false; error: string }>;
}

const FROM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/u;

function sessionIdentity(
  kind: string | undefined,
  sessionId: string | undefined,
  from: string,
): { sessionId?: string; error?: string } {
  if (kind === undefined && sessionId === undefined) return {};
  if (kind === undefined || sessionId === undefined)
    return { error: 'kind and sessionId are both required' };
  const parsed = agentSenderSchema.safeParse({ kind, sessionId });
  if (!parsed.success) return { error: 'invalid kind-specific session identity' };
  if (parsed.data.kind !== from) return { error: 'sender kind must match from' };
  return { sessionId: parsed.data.sessionId };
}

async function allowed(
  from: string,
  deps: VerdictRouteDeps,
  senderSessionId?: string,
): Promise<string | undefined> {
  if (!FROM_PATTERN.test(from)) return 'invalid sender';
  if (senderSessionId !== undefined) return undefined;
  const sender = await deps.validateFrom?.(from);
  return sender && !sender.ok ? sender.error : undefined;
}

export async function handleVerdictRead(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  deps: VerdictRouteDeps,
): Promise<void> {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET only' });
  const from = (url.searchParams.get('from') ?? '').trim();
  const id = (url.searchParams.get('id') ?? '').trim();
  const identity = sessionIdentity(
    url.searchParams.get('kind') ?? undefined,
    url.searchParams.get('sessionId') ?? undefined,
    from,
  );
  const error = identity.error ?? (await allowed(from, deps, identity.sessionId));
  if (error) return sendJson(res, 400, { error });
  try {
    const body = readVerdictArtifact(deps.paths(), id, from, identity.sessionId);
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
    res.end(body);
    return;
  } catch {
    return sendJson(res, 404, { error: 'verdict unavailable for this sender and exchange' });
  }
}

export async function handleVerdictAck(
  res: http.ServerResponse,
  url: URL,
  fields: Readonly<Record<string, unknown>>,
  deps: VerdictRouteDeps,
): Promise<void> {
  if (
    url.searchParams.size > 0 ||
    Object.keys(fields).some((key) => !['from', 'id', 'kind', 'sessionId'].includes(key))
  ) {
    return sendJson(res, 400, { error: 'ack-verdict accepts only from and id in the body' });
  }
  const from = typeof fields['from'] === 'string' ? fields['from'].trim() : '';
  const id = typeof fields['id'] === 'string' ? fields['id'].trim() : '';
  const identity = sessionIdentity(
    typeof fields['kind'] === 'string' ? fields['kind'] : undefined,
    typeof fields['sessionId'] === 'string' ? fields['sessionId'] : undefined,
    from,
  );
  const error = identity.error ?? (await allowed(from, deps, identity.sessionId));
  if (error) return sendJson(res, 400, { error });
  try {
    acknowledgeVerdict(deps.paths(), id, from, identity.sessionId);
  } catch {
    return sendJson(res, 404, { error: 'verdict unavailable for this sender and exchange' });
  }
  return sendJson(res, 200, { acknowledged: true });
}
