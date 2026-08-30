import { randomInt, timingSafeEqual } from 'crypto';
import type * as vscode from 'vscode';
import type { RemoteInboundEvent } from './types';
import {
  RemoteSessionAuth,
  type RemoteGateResult,
  type RemoteSessionPolicy,
  totpSecretKey,
} from './RemoteSessionAuth';

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

export class RemoteAuth {
  private pairing: PairingSession | undefined;
  private readonly sessionAuth: RemoteSessionAuth;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    policy: RemoteSessionPolicy = { inactivityTimeoutMinutes: 30 },
  ) {
    this.sessionAuth = new RemoteSessionAuth(secrets, policy);
  }

  updateSessionPolicy(policy: RemoteSessionPolicy): void {
    this.sessionAuth.updatePolicy(policy);
  }

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
    const supplied = Buffer.from(match[1]!, 'utf8');
    const expected = Buffer.from(session.code, 'utf8');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      if (session.attempts >= MAX_PAIR_ATTEMPTS) this.pairing = undefined;
      return 'rejected';
    }
    // Persist authority before invalidating the one-time code or confirming.
    await this.secrets.store(ownerSecretKey(event.channel), event.senderId);
    this.sessionAuth.lock(event.channel, event.senderId);
    this.pairing = undefined;
    return 'paired';
  }

  async unpair(channel: RemoteInboundEvent['channel']): Promise<void> {
    const owner = await this.secrets.get(ownerSecretKey(channel));
    await this.secrets.delete(ownerSecretKey(channel));
    await this.secrets.delete(totpSecretKey(channel));
    if (owner) this.sessionAuth.lock(channel, owner);
    this.sessionAuth.clearChannel(channel);
  }

  async hasOwner(channel: RemoteInboundEvent['channel']): Promise<boolean> {
    return (await this.secrets.get(ownerSecretKey(channel))) !== undefined;
  }

  async gate(event: RemoteInboundEvent): Promise<RemoteGateResult> {
    return this.sessionAuth.gate(event, event.senderId);
  }

  touch(event: RemoteInboundEvent): void {
    this.sessionAuth.touch(event.channel, event.senderId, event.chatId);
  }

  lock(event: RemoteInboundEvent): void {
    this.sessionAuth.lock(event.channel, event.senderId);
  }

  async canDeliver(channel: RemoteInboundEvent['channel'], chatId: string): Promise<boolean> {
    const owner = await this.secrets.get(ownerSecretKey(channel));
    if (!owner) return false;
    if (!(await this.sessionAuth.isEnrolled(channel, owner))) return true;
    return this.sessionAuth.canUse(channel, owner, chatId);
  }

  async approvalNonce(
    channel: RemoteInboundEvent['channel'],
    chatId: string,
  ): Promise<string | undefined> {
    const owner = await this.secrets.get(ownerSecretKey(channel));
    if (!owner || !(await this.sessionAuth.isEnrolled(channel, owner))) return undefined;
    return this.sessionAuth.currentNonce(channel, owner, chatId);
  }

  async createTotpEnrollmentSecret(channel: RemoteInboundEvent['channel']): Promise<string> {
    if (!(await this.hasOwner(channel)))
      throw new Error(`Forge remote ${channel} has no paired owner.`);
    return this.sessionAuth.createEnrollmentSecret();
  }

  async confirmTotpEnrollment(
    channel: RemoteInboundEvent['channel'],
    secret: string,
    code: string,
    now = Date.now(),
  ): Promise<void> {
    const owner = await this.secrets.get(ownerSecretKey(channel));
    if (!owner) throw new Error(`Forge remote ${channel} has no paired owner.`);
    await this.sessionAuth.confirmEnrollment(channel, owner, secret, code, now);
  }

  async disableTotp(channel: RemoteInboundEvent['channel']): Promise<void> {
    const owner = await this.secrets.get(ownerSecretKey(channel));
    if (!owner) throw new Error(`Forge remote ${channel} has no paired owner.`);
    await this.sessionAuth.disable(channel, owner);
  }

  async totpEnrolled(channel: RemoteInboundEvent['channel']): Promise<boolean> {
    const owner = await this.secrets.get(ownerSecretKey(channel));
    return owner ? this.sessionAuth.isEnrolled(channel, owner) : false;
  }
}
