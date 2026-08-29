import { createHash, randomInt, timingSafeEqual } from 'crypto';
import type * as vscode from 'vscode';
import type { RemoteInboundEvent } from './types';

const PAIR_TTL_MS = 5 * 60_000;
const MAX_PAIR_ATTEMPTS = 5;

interface PairingSession {
  channel: RemoteInboundEvent['channel'];
  code: string;
  expiresAt: number;
  attempts: number;
}

function ownerSecretKey(channel: string): string {
  return `forge.remote.${channel}.ownerId`;
}

export function redactRemoteIdentity(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export class RemoteAuth {
  private pairing: PairingSession | undefined;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  beginPairing(channel: RemoteInboundEvent['channel'], now = Date.now()): string {
    const code = randomInt(0, 100_000_000).toString().padStart(8, '0');
    this.pairing = { channel, code, expiresAt: now + PAIR_TTL_MS, attempts: 0 };
    return code;
  }

  cancelPairing(): void {
    this.pairing = undefined;
  }

  async isOwner(event: RemoteInboundEvent): Promise<boolean> {
    const owner = await this.secrets.get(ownerSecretKey(event.channel));
    return owner !== undefined && owner === event.senderId;
  }

  async tryPair(event: RemoteInboundEvent, now = Date.now()): Promise<'paired' | 'rejected'> {
    if (event.kind !== 'text' || event.chatType !== 'private') return 'rejected';
    const match = /^\/pair ([0-9]{8})$/.exec(event.text);
    const session = this.pairing;
    if (!match || !session || session.channel !== event.channel || now > session.expiresAt) {
      return 'rejected';
    }
    session.attempts += 1;
    if (session.attempts > MAX_PAIR_ATTEMPTS) {
      this.pairing = undefined;
      return 'rejected';
    }
    const supplied = Buffer.from(match[1]!, 'utf8');
    const expected = Buffer.from(session.code, 'utf8');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return 'rejected';
    }
    // Persist authority before invalidating the one-time code or confirming.
    await this.secrets.store(ownerSecretKey(event.channel), event.senderId);
    this.pairing = undefined;
    return 'paired';
  }

  async unpair(channel: RemoteInboundEvent['channel']): Promise<void> {
    await this.secrets.delete(ownerSecretKey(channel));
  }
}
