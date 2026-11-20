import { timingSafeEqual } from 'crypto';
import type * as http from 'http';

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function readJson(
  req: http.IncomingMessage,
  maxBytes = 64 * 1024,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const data = Buffer.concat(chunks).toString('utf8');
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

/**
 * Constant-time compare an `Authorization: Bearer <token>` header against an
 * expected token. Shared by the control server's model routes and the
 * `/agent/*` routes (agentRoutes.ts) so the compare lives in exactly one place.
 * A missing or malformed header never matches. */
export function bearerTokenMatches(header: string | undefined, expected: string): boolean {
  const given = Buffer.from((header ?? '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}
