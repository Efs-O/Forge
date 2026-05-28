import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';

interface OpenCodeXaiEntry {
  type?: string;
  access?: string;
  refresh?: string;
  expires?: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

const OPENCODE_AUTH_PATH = path.join(
  os.homedir(), '.local', 'share', 'opencode', 'auth.json',
);

const XAI_TOKEN_ENDPOINT = 'https://auth.x.ai/oauth2/token';
const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';

async function refreshAndPersist(entry: OpenCodeXaiEntry): Promise<string> {
  if (!entry.refresh) throw new Error('xAI: refresh token missing — reconnect xAI in OpenCode.');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: entry.refresh,
    client_id: XAI_CLIENT_ID,
  });

  const res = await fetch(XAI_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`xAI token refresh failed (${res.status}): ${text} — reconnect xAI in OpenCode.`);
  }

  const tokens = await res.json() as TokenResponse;

  // Write refreshed tokens back so future reads (by Forge and OpenCode) get the new values.
  try {
    const raw = fs.readFileSync(OPENCODE_AUTH_PATH, 'utf8');
    const auth = JSON.parse(raw) as Record<string, OpenCodeXaiEntry>;
    auth['xai'] = {
      ...auth['xai'],
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      expires: Date.now() + tokens.expires_in * 1000,
    };
    fs.writeFileSync(OPENCODE_AUTH_PATH, JSON.stringify(auth, null, 2), 'utf8');
  } catch {
    // Non-fatal — we still have the fresh token for this session.
  }

  return tokens.access_token;
}

/**
 * Resolves the xAI bearer token.
 * Priority: VS Code SecretStorage (manual) → OpenCode auth.json (auto-refreshed).
 * If the token in auth.json is expired, automatically refreshes it via OAuth2.
 */
export async function resolveXaiToken(
  secretKeyName: string | undefined,
  secrets: vscode.SecretStorage | undefined,
): Promise<string> {
  if (secretKeyName && secrets) {
    const stored = await secrets.get(secretKeyName);
    if (stored) return stored;
  }

  let entry: OpenCodeXaiEntry;
  try {
    const raw = fs.readFileSync(OPENCODE_AUTH_PATH, 'utf8');
    const auth = JSON.parse(raw) as Record<string, OpenCodeXaiEntry>;
    entry = auth['xai'] ?? {};
  } catch {
    throw new Error(
      'xAI: OpenCode auth file not found. Connect xAI in OpenCode first, or run "Forge: Set Cloud Provider Token" (key: xai).',
    );
  }

  if (!entry.access) {
    throw new Error(
      'xAI: no token in OpenCode auth file. Connect xAI in OpenCode first, or run "Forge: Set Cloud Provider Token" (key: xai).',
    );
  }

  // Token still valid — return it directly.
  if (!entry.expires || Date.now() < entry.expires - 60_000) {
    return entry.access;
  }

  // Expired — refresh automatically.
  return refreshAndPersist(entry);
}
