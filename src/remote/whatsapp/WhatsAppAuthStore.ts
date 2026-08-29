import * as fs from 'fs/promises';
import * as path from 'path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'crypto';
import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import type {
  AuthenticationState,
  SignalDataSet,
  SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import type * as vscode from 'vscode';
import { z } from 'zod';

const AUTH_KEY_SECRET = 'forge.remote.whatsapp.authEncryptionKey';
const EnvelopeSchema = z.object({
  version: z.literal(1),
  iv: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
});

interface PersistedAuth {
  creds: AuthenticationState['creds'];
  keys: Record<string, Record<string, unknown>>;
}

export interface WhatsAppAuthSession {
  state: AuthenticationState;
  saveCreds(): Promise<void>;
  clear(): Promise<void>;
}

/** AES-GCM auth persistence: ciphertext in global storage, key in SecretStorage. */
export class WhatsAppAuthStore {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly secrets: vscode.SecretStorage,
  ) {}

  async load(): Promise<WhatsAppAuthSession> {
    const persisted = await this.read();
    const auth: PersistedAuth = persisted ?? { creds: initAuthCreds(), keys: {} };
    let cleared = false;
    const persist = (): Promise<void> =>
      cleared
        ? Promise.resolve()
        : this.serialize(() => (cleared ? Promise.resolve() : this.write(auth)));
    const state: AuthenticationState = {
      creds: auth.creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const result: { [id: string]: SignalDataTypeMap[T] } = {};
          for (const id of ids) {
            let value = auth.keys[type]?.[id];
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            if (value !== undefined && value !== null) {
              result[id] = value as SignalDataTypeMap[T];
            }
          }
          return result;
        },
        set: async (data: SignalDataSet) => {
          for (const [category, entries] of Object.entries(data)) {
            const bucket = (auth.keys[category] ??= {});
            for (const [id, value] of Object.entries(entries ?? {})) {
              if (value === null || value === undefined) delete bucket[id];
              else bucket[id] = value;
            }
          }
          await persist();
        },
        clear: async () => {
          auth.keys = {};
          await persist();
        },
      },
    };
    return {
      state,
      saveCreds: persist,
      clear: async () => {
        await this.serialize(async () => {
          cleared = true;
          await fs.unlink(this.filePath).catch((err: NodeJS.ErrnoException) => {
            if (err.code !== 'ENOENT') throw err;
          });
          await this.secrets.delete(AUTH_KEY_SECRET);
        });
      },
    };
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async read(): Promise<PersistedAuth | undefined> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    const encodedKey = await this.secrets.get(AUTH_KEY_SECRET);
    if (!encodedKey) {
      throw new Error('Forge WhatsApp auth is encrypted but its SecretStorage key is missing.');
    }
    const envelope = EnvelopeSchema.parse(JSON.parse(raw));
    const decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(encodedKey, 'base64'),
      Buffer.from(envelope.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plaintext, BufferJSON.reviver) as PersistedAuth;
  }

  private async write(auth: PersistedAuth): Promise<void> {
    const key = await this.encryptionKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const plaintext = JSON.stringify(auth, BufferJSON.replacer);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const envelope = {
      version: 1 as const,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, this.filePath);
  }

  private async encryptionKey(): Promise<Buffer> {
    const existing = await this.secrets.get(AUTH_KEY_SECRET);
    if (existing) {
      const decoded = Buffer.from(existing, 'base64');
      if (decoded.length !== 32) throw new Error('Forge WhatsApp auth key is invalid.');
      return decoded;
    }
    const key = randomBytes(32);
    await this.secrets.store(AUTH_KEY_SECRET, key.toString('base64'));
    return key;
  }
}
