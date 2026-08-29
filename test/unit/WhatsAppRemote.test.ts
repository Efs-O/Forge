import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { WAMessage } from '@whiskeysockets/baileys';
import { toRemoteEvent } from '../../src/remote/whatsapp/BaileysWhatsAppChannel';
import { WhatsAppAuthStore } from '../../src/remote/whatsapp/WhatsAppAuthStore';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const directory of tempDirs.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

class MemorySecrets {
  readonly values = new Map<string, string>();
  get(key: string): Thenable<string | undefined> {
    return Promise.resolve(this.values.get(key));
  }
  store(key: string, value: string): Thenable<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Thenable<void> {
    this.values.delete(key);
    return Promise.resolve();
  }
  onDidChange = vi.fn();
}

describe('WhatsAppAuthStore', () => {
  it('round-trips credentials and signal keys only as encrypted global-storage data', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-wa-auth-'));
    tempDirs.push(directory);
    const filePath = path.join(directory, 'auth.enc.json');
    const secrets = new MemorySecrets();
    const store = new WhatsAppAuthStore(filePath, secrets as unknown as vscode.SecretStorage);
    const first = await store.load();
    first.state.creds.registered = true;
    await first.state.keys.set({ session: { device: Buffer.from('signal-secret') } });
    await first.saveCreds();

    const raw = await fs.readFile(filePath, 'utf8');
    expect(raw).not.toContain('signal-secret');
    expect(raw).not.toContain('registered');
    expect(secrets.values.size).toBe(1);

    const second = await new WhatsAppAuthStore(
      filePath,
      secrets as unknown as vscode.SecretStorage,
    ).load();
    expect(second.state.creds.registered).toBe(true);
    const keys = await second.state.keys.get('session', ['device']);
    expect(Buffer.from(keys.device!)).toEqual(Buffer.from('signal-secret'));
    await second.clear();
    await expect(fs.readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(secrets.values.size).toBe(0);
    await second.saveCreds();
    await expect(fs.readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when ciphertext exists but its SecretStorage key is missing', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-wa-auth-'));
    tempDirs.push(directory);
    const filePath = path.join(directory, 'auth.enc.json');
    const secrets = new MemorySecrets();
    const first = await new WhatsAppAuthStore(
      filePath,
      secrets as unknown as vscode.SecretStorage,
    ).load();
    await first.saveCreds();
    secrets.values.clear();
    await expect(
      new WhatsAppAuthStore(filePath, secrets as unknown as vscode.SecretStorage).load(),
    ).rejects.toThrow('SecretStorage key is missing');
  });
});

describe('Baileys WhatsApp event mapping', () => {
  it('maps direct text to a private stable-identity event', () => {
    const message = {
      key: { id: 'message-1', remoteJid: '15551234567@s.whatsapp.net', fromMe: false },
      messageTimestamp: 10,
      message: { conversation: 'hello' },
    } as WAMessage;
    expect(toRemoteEvent(message)).toEqual({
      channel: 'whatsapp',
      kind: 'text',
      providerMessageId: 'message-1',
      senderId: '15551234567@s.whatsapp.net',
      chatId: '15551234567@s.whatsapp.net',
      chatType: 'private',
      receivedAt: 10_000,
      text: 'hello',
    });
  });

  it('maps exact approval replies and preserves group classification for core rejection', () => {
    const message = {
      key: {
        id: 'message-2',
        remoteJid: 'group@g.us',
        participant: 'owner@s.whatsapp.net',
        fromMe: false,
      },
      messageTimestamp: 11,
      message: { extendedTextMessage: { text: 'APPROVE approval-1' } },
    } as WAMessage;
    expect(toRemoteEvent(message)).toMatchObject({
      kind: 'action',
      action: 'approve',
      correlationId: 'approval-1',
      senderId: 'owner@s.whatsapp.net',
      chatType: 'group',
    });
  });

  it('ignores unsupported or identifier-less messages', () => {
    expect(
      toRemoteEvent({ key: { remoteJid: 'owner@s.whatsapp.net' }, message: {} } as WAMessage),
    ).toBeUndefined();
  });
});
