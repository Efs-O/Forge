import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { getLogger } from '../util/logger';

const log = getLogger();

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

const OPENCODE_AUTH_PATH = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');

const XAI_TOKEN_ENDPOINT = 'https://auth.x.ai/oauth2/token';
const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';

async function refreshAndPersist(entry: OpenCodeXaiEntry): Promise<string> {
  if (!entry.refresh) throw new Error('xAI: refresh token missing — reconnect xAI in OpenCode.');

  log.info('[xAI] Access token expired — refreshing via OAuth2...');
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
    const msg = `xAI token refresh failed (${res.status}): ${text} — reconnect xAI in OpenCode.`;
    log.error(`[xAI] ${msg}`);
    throw new Error(msg);
  }

  const tokens = (await res.json()) as TokenResponse;
  log.info(`[xAI] Token refreshed successfully, valid for ${tokens.expires_in / 3600}h`);

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
    log.info('[xAI] auth.json updated with new tokens');
  } catch (err) {
    log.warn(`[xAI] Could not write auth.json: ${(err as Error).message}`);
  }

  return tokens.access_token;
}

function jwtExpired(token: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as {
      exp?: number;
    };
    return typeof payload.exp === 'number' && Date.now() / 1000 > payload.exp - 60;
  } catch {
    return false; // can't decode — assume valid, let the API reject it if not
  }
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
  log.debug(`[xAI] resolveXaiToken — secretKey=${secretKeyName ?? 'none'}`);

  if (secretKeyName && secrets) {
    const stored = await secrets.get(secretKeyName);
    if (stored && !jwtExpired(stored)) {
      log.debug('[xAI] Using valid token from SecretStorage');
      return stored;
    }
    if (stored) log.debug('[xAI] SecretStorage token is expired, falling back to auth.json');
    else log.debug('[xAI] SecretStorage key not found, falling back to auth.json');
  }

  let entry: OpenCodeXaiEntry;
  try {
    const raw = fs.readFileSync(OPENCODE_AUTH_PATH, 'utf8');
    const auth = JSON.parse(raw) as Record<string, OpenCodeXaiEntry>;
    entry = auth['xai'] ?? {};
    log.debug(
      `[xAI] auth.json loaded — expires=${entry.expires ? new Date(entry.expires).toISOString() : 'none'}`,
    );
  } catch (err) {
    const msg =
      'xAI: OpenCode auth file not found. Connect xAI in OpenCode first, or run "Forge: Set Cloud Provider Token" (key: xai).';
    log.error(`[xAI] ${msg} (${(err as Error).message})`);
    throw new Error(msg);
  }

  if (!entry.access) {
    const msg =
      'xAI: no token in OpenCode auth file. Connect xAI in OpenCode first, or run "Forge: Set Cloud Provider Token" (key: xai).';
    log.error(`[xAI] ${msg}`);
    throw new Error(msg);
  }

  if (!entry.expires || Date.now() < entry.expires - 60_000) {
    log.debug('[xAI] Token is valid, using directly');
    return entry.access;
  }

  log.info('[xAI] Token expired, auto-refreshing...');
  return refreshAndPersist(entry);
}
