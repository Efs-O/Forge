import type * as http from 'http';

const MAX_BODY_BYTES = 64 * 1024;

/** Small HTTP/serialization helpers for the control server (kept out of
 *  ControlServer.ts so the route/lifecycle logic stays within the file budget). */

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function requireModel(body: Record<string, unknown>): string | null {
  const model = typeof body['model'] === 'string' ? body['model'].trim() : '';
  return model || null;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function toOpenAiBase(baseUrl: string): string {
  const u = baseUrl.replace(/\/+$/, '');
  return /\/v1$/.test(u) ? u : `${u}/v1`;
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      data += chunk.toString();
    });
    req.on('end', () => {
      if (!data.trim()) return resolve({});
      try {
        resolve(JSON.parse(data) as Record<string, unknown>);
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}
