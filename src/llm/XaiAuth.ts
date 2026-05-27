import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';

interface OpenCodeXaiEntry {
  access?: string;
  expires?: number;
}

const OPENCODE_AUTH_PATH = path.join(
  os.homedir(), '.local', 'share', 'opencode', 'auth.json',
);

/**
 * Resolves the xAI bearer token.
 * Priority: VS Code SecretStorage (manual) → OpenCode auth.json (auto-refreshed by OpenCode).
 * Throws with a user-readable message if no valid token is found.
 */
export async function resolveXaiToken(
  secretKeyName: string | undefined,
  secrets: vscode.SecretStorage | undefined,
): Promise<string> {
  if (secretKeyName && secrets) {
    const stored = await secrets.get(secretKeyName);
    if (stored) return stored;
  }

  try {
    const raw = fs.readFileSync(OPENCODE_AUTH_PATH, 'utf8');
    const auth = JSON.parse(raw) as Record<string, OpenCodeXaiEntry>;
    const entry = auth['xai'];
    if (!entry?.access) throw new Error('no-entry');
    if (entry.expires && Date.now() > entry.expires) {
      throw new Error('xAI token expired — open OpenCode and send a message to refresh it, then retry.');
    }
    return entry.access;
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.startsWith('xAI token expired')) throw new Error(msg);
    if (msg !== 'no-entry') throw new Error(
      'xAI: no token found. Run "Forge: Set Cloud Provider Token" (key: xai), or connect xAI in OpenCode first.',
    );
    throw new Error(
      'xAI: no token found. Run "Forge: Set Cloud Provider Token" (key: xai), or connect xAI in OpenCode first.',
    );
  }
}
