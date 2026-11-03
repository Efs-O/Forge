import * as http from 'http';
import { randomUUID } from 'crypto';
import type { ModelConfig } from '../config/types';
import type { CloudRequestTarget } from './CloudRequestResolver';

const ERROR_BODY_CAP = 64 * 1024;

export type CloudRelayTargetResolver = (model: ModelConfig) => Promise<CloudRequestTarget>;

export interface CloudRelayForwardOptions {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  body: Record<string, unknown>;
  model: ModelConfig;
  route: string;
  upstreamPath: string;
  resolveTarget: CloudRelayTargetResolver;
  shutdownSignal: AbortSignal;
  logLine(message: string): void;
  fetchImpl?: typeof fetch;
}

function jsonError(message: string): string {
  return JSON.stringify({ error: { message } });
}

async function readCapped(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < ERROR_BODY_CAP) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    const remaining = ERROR_BODY_CAP - size;
    const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
    chunks.push(chunk);
    size += chunk.byteLength;
    if (chunk.byteLength !== value.byteLength) break;
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function replaceModel(body: Record<string, unknown>, model: ModelConfig): string {
  return JSON.stringify({ ...body, model: model.name });
}

function writeHeaders(res: http.ServerResponse, status: number, contentType: string | null): void {
  res.writeHead(status, contentType ? { 'content-type': contentType } : {});
}

function waitForDrain(res: http.ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    res.once('drain', resolve);
    res.once('error', reject);
    res.once('close', () => reject(new Error('relay client disconnected')));
  });
}

/** Forward one provider request. Incoming credentials and all X-* headers are never copied. */
export async function forwardCloudRequest(options: CloudRelayForwardOptions): Promise<void> {
  const startedAt = Date.now();
  const requestId = randomUUID();
  const declaredBytes = Number(options.req.headers['content-length'] ?? '');
  const bytesIn =
    Number.isFinite(declaredBytes) && declaredBytes > 0
      ? declaredBytes
      : Buffer.byteLength(JSON.stringify(options.body));
  let bytesOut = 0;
  let status = 502;
  const controller = new AbortController();
  const abortForShutdown = (): void => controller.abort();
  const abortForClient = (): void => {
    if (!options.res.writableEnded) controller.abort();
  };
  options.shutdownSignal.addEventListener('abort', abortForShutdown, { once: true });
  options.res.once('close', abortForClient);
  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const target = await options.resolveTarget(options.model);
    const upstreamUrl = `${target.baseUrl.replace(/\/+$/, '')}${options.upstreamPath}`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (options.route === 'POST /v1/chat/completions' && target.apiKey) {
      headers.authorization = `Bearer ${target.apiKey}`;
    }
    const response = await (options.fetchImpl ?? fetch)(upstreamUrl, {
      method: 'POST',
      headers,
      body: replaceModel(options.body, options.model),
      redirect: 'manual',
      signal: controller.signal,
    });
    status = response.status;
    const contentType = response.headers.get('content-type');
    writeHeaders(options.res, response.status, contentType);
    upstreamReader = response.body?.getReader();
    if (!upstreamReader) {
      options.res.end();
      return;
    }
    if (response.status >= 400) {
      const errorBytes = await readCapped(upstreamReader);
      const text = new TextDecoder().decode(errorBytes);
      const safe = target.apiKey ? text.split(target.apiKey).join('[redacted]') : text;
      const safeBytes = Buffer.from(safe);
      bytesOut += safeBytes.byteLength;
      options.res.end(safeBytes);
      return;
    }
    while (!controller.signal.aborted) {
      const { done, value } = await upstreamReader.read();
      if (done) break;
      if (!value) continue;
      bytesOut += value.byteLength;
      if (!options.res.write(value)) await waitForDrain(options.res);
    }
    if (!options.res.destroyed) options.res.end();
  } catch (error) {
    if (!controller.signal.aborted && !options.res.headersSent) {
      writeHeaders(options.res, 502, 'application/json');
      const message = error instanceof Error ? error.message : String(error);
      const bytes = Buffer.from(jsonError(message));
      bytesOut += bytes.byteLength;
      options.res.end(bytes);
    } else if (!options.res.destroyed && !options.res.writableEnded) {
      options.res.end();
    }
  } finally {
    await upstreamReader?.cancel().catch(() => undefined);
    options.shutdownSignal.removeEventListener('abort', abortForShutdown);
    options.res.off('close', abortForClient);
    options.logLine(
      `[CloudRelay] id=${requestId} route=${options.route} model=${options.model.name} ` +
        `status=${status} duration_ms=${Date.now() - startedAt} bytes_in=${bytesIn} bytes_out=${bytesOut}`,
    );
  }
}
