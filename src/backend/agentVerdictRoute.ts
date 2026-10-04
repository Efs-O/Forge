import type * as http from 'http';
import type { BusPaths } from '../agentBus/agentBus';
import { acknowledgeVerdict, readVerdictArtifact } from '../agentMesh/verdictArtifact';
import { sendJson } from './controlHttp';

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

async function allowed(from: string, deps: VerdictRouteDeps): Promise<string | undefined> {
  if (!FROM_PATTERN.test(from)) return 'invalid sender';
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
  const error = await allowed(from, deps);
  if (error) return sendJson(res, 400, { error });
  try {
    const body = readVerdictArtifact(deps.paths(), id, from);
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
    Object.keys(fields).some((key) => key !== 'from' && key !== 'id')
  ) {
    return sendJson(res, 400, { error: 'ack-verdict accepts only from and id in the body' });
  }
  const from = typeof fields['from'] === 'string' ? fields['from'].trim() : '';
  const id = typeof fields['id'] === 'string' ? fields['id'].trim() : '';
  const error = await allowed(from, deps);
  if (error) return sendJson(res, 400, { error });
  try {
    acknowledgeVerdict(deps.paths(), id, from);
  } catch {
    return sendJson(res, 404, { error: 'verdict unavailable for this sender and exchange' });
  }
  return sendJson(res, 200, { acknowledged: true });
}
