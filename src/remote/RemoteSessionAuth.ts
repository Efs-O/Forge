import { randomBytes, randomUUID } from 'crypto';
import type * as vscode from 'vscode';
import type { RemoteInboundEvent } from './types';
import { verifyTotp } from './RemoteTotp';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const MAX_FAILURES = 5;
const LOCKOUT_MS = 5 * 60_000;

export type RemoteAuthState = 'locked' | 'awaiting_totp' | 'authenticated';

export interface RemoteSessionPolicy {
  inactivityTimeoutMinutes: number;
}

export interface TotpEnrollment {
  secret: string;
  ownerId: string;
  enrolledAt: number;
}

interface AuthSession {
  ownerId: string;
  chatId: string;
  state: RemoteAuthState;
  nonce?: string;
  lastActivityAt?: number;
  lastAcceptedStep?: number;
  failedAttempts: number;
  lockedOutUntil?: number;
  /** Set only when inactivity is what locked this session, so the challenge can say so. */
  expiredFromInactivity?: boolean;
}

export type RemoteGateResult =
  | { kind: 'authorized'; nonce?: string; newlyAuthenticated?: boolean }
  | { kind: 'challenge'; reason: 'expired' | 'locked' }
  | { kind: 'failed' }
  | { kind: 'locked_out' }
  | { kind: 'blocked' };

export function totpSecretKey(channel: RemoteInboundEvent['channel']): string {
  return `forge.remote.${channel}.totp`;
}

/**
 * Memory-only remote TOTP sessions and SecretStorage-backed owner enrollment.
 * Pairing remains in RemoteAuth; callers must establish the exact owner before
 * presenting an event to this boundary.
 */
export class RemoteSessionAuth {
  private readonly sessions = new Map<string, AuthSession>();

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private policy: RemoteSessionPolicy,
  ) {}

  updatePolicy(policy: RemoteSessionPolicy): void {
    this.policy = policy;
  }

  createEnrollmentSecret(bytes = 32): string {
    if (!Number.isInteger(bytes) || bytes < 20) {
      throw new Error('Forge remote TOTP enrollment needs at least 160 random bits.');
    }
    return encodeBase32(randomBytes(bytes));
  }

  async confirmEnrollment(
    channel: RemoteInboundEvent['channel'],
    ownerId: string,
    secret: string,
    code: string,
    now = Date.now(),
  ): Promise<void> {
    if (verifyTotp(secret, code, { now, skewSteps: 1 }) === undefined) {
      throw new Error('Forge remote authenticator code is invalid.');
    }
    await this.secrets.store(
      totpSecretKey(channel),
      JSON.stringify({ version: 1, secret, ownerId, enrolledAt: now }),
    );
    this.lock(channel, ownerId);
  }

  async disable(channel: RemoteInboundEvent['channel'], ownerId: string): Promise<void> {
    const enrollment = await this.enrollment(channel);
    if (enrollment && enrollment.ownerId !== ownerId) {
      throw new Error('Forge remote authenticator belongs to a different owner.');
    }
    await this.secrets.delete(totpSecretKey(channel));
    this.lock(channel, ownerId);
  }

  async isEnrolled(channel: RemoteInboundEvent['channel'], ownerId: string): Promise<boolean> {
    return (await this.enrollment(channel))?.ownerId === ownerId;
  }

  /** Authenticates or authorizes one owner-verified inbound event. */
  async gate(
    event: RemoteInboundEvent,
    ownerId: string,
    now = Date.now(),
  ): Promise<RemoteGateResult> {
    const enrollment = await this.enrollment(event.channel);
    // Explicit local-only disable keeps existing installations operational until
    // their owner chooses to enroll. It is not a remote recovery path.
    if (!enrollment) return { kind: 'authorized' };
    if (enrollment.ownerId !== ownerId) return { kind: 'blocked' };

    const session = this.session(event.channel, ownerId, event.chatId);
    this.expire(session, now);
    if (session.lockedOutUntil && now < session.lockedOutUntil) return { kind: 'locked_out' };

    if (session.state === 'authenticated') {
      return event.kind === 'action' || event.kind === 'selection' || event.kind === 'text'
        ? {
            kind: 'authorized',
            ...(session.nonce ? { nonce: session.nonce } : {}),
          }
        : { kind: 'blocked' };
    }
    if (event.kind !== 'text') return { kind: 'blocked' };

    const candidate = extractCode(event.text);
    if (!candidate) {
      session.state = 'awaiting_totp';
      return {
        kind: 'challenge',
        reason: session.expiredFromInactivity ? 'expired' : 'locked',
      };
    }
    const step = verifyTotp(enrollment.secret, candidate, {
      now,
      skewSteps: 1,
      ...(session.lastAcceptedStep === undefined
        ? {}
        : { rejectedSteps: new Set([session.lastAcceptedStep]) }),
    });
    if (step === undefined) {
      session.failedAttempts += 1;
      if (session.failedAttempts >= MAX_FAILURES) {
        session.lockedOutUntil = now + LOCKOUT_MS;
        session.failedAttempts = 0;
        session.state = 'locked';
        return { kind: 'locked_out' };
      }
      session.state = 'awaiting_totp';
      return { kind: 'failed' };
    }

    session.state = 'authenticated';
    session.nonce = randomUUID();
    session.lastActivityAt = now;
    session.lastAcceptedStep = step;
    session.failedAttempts = 0;
    delete session.lockedOutUntil;
    delete session.expiredFromInactivity;
    return { kind: 'authorized', nonce: session.nonce, newlyAuthenticated: true };
  }

  touch(
    channel: RemoteInboundEvent['channel'],
    ownerId: string,
    chatId: string,
    now = Date.now(),
  ): void {
    const session = this.sessions.get(sessionKey(channel, ownerId));
    if (!session || session.chatId !== chatId || session.state !== 'authenticated') return;
    this.expire(session, now);
    if (session.state === 'authenticated') session.lastActivityAt = now;
  }

  canUse(
    channel: RemoteInboundEvent['channel'],
    ownerId: string,
    chatId: string,
    now = Date.now(),
  ): boolean {
    const session = this.sessions.get(sessionKey(channel, ownerId));
    if (!session || session.chatId !== chatId) return false;
    this.expire(session, now);
    return session.state === 'authenticated';
  }

  currentNonce(
    channel: RemoteInboundEvent['channel'],
    ownerId: string,
    chatId: string,
    now = Date.now(),
  ): string | undefined {
    const session = this.sessions.get(sessionKey(channel, ownerId));
    if (!session || session.chatId !== chatId) return undefined;
    this.expire(session, now);
    return session.state === 'authenticated' ? session.nonce : undefined;
  }

  lock(channel: RemoteInboundEvent['channel'], ownerId: string): void {
    const existing = this.sessions.get(sessionKey(channel, ownerId));
    if (!existing) return;
    existing.state = 'locked';
    delete existing.nonce;
    delete existing.lastActivityAt;
    existing.failedAttempts = 0;
    delete existing.lockedOutUntil;
    // A deliberate lock is not an inactivity expiry -- do not let the next
    // challenge blame a timeout the user did not hit.
    delete existing.expiredFromInactivity;
  }

  clearChannel(channel: RemoteInboundEvent['channel']): void {
    for (const key of this.sessions.keys()) {
      if (key.startsWith(`${channel}:`)) this.sessions.delete(key);
    }
  }

  private async enrollment(
    channel: RemoteInboundEvent['channel'],
  ): Promise<TotpEnrollment | undefined> {
    const raw = await this.secrets.get(totpSecretKey(channel));
    if (!raw) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error('Forge remote TOTP enrollment is invalid. Reset it locally.');
    }
    if (!isEnrollment(value))
      throw new Error('Forge remote TOTP enrollment is invalid. Reset it locally.');
    return value;
  }

  private session(
    channel: RemoteInboundEvent['channel'],
    ownerId: string,
    chatId: string,
  ): AuthSession {
    const key = sessionKey(channel, ownerId);
    const current = this.sessions.get(key);
    if (current && current.chatId === chatId) return current;
    const next: AuthSession = {
      ownerId,
      chatId,
      state: 'locked',
      failedAttempts: 0,
    };
    this.sessions.set(key, next);
    return next;
  }

  private expire(session: AuthSession, now: number): void {
    const timeout = this.policy.inactivityTimeoutMinutes;
    if (
      timeout > 0 &&
      session.state === 'authenticated' &&
      session.lastActivityAt !== undefined &&
      now - session.lastActivityAt >= timeout * 60_000
    ) {
      this.lockSession(session);
      session.expiredFromInactivity = true;
    }
  }

  private lockSession(session: AuthSession): void {
    session.state = 'locked';
    delete session.nonce;
    delete session.lastActivityAt;
  }
}

function sessionKey(channel: RemoteInboundEvent['channel'], ownerId: string): string {
  return `${channel}:${ownerId}`;
}

function extractCode(text: string): string | undefined {
  const direct = /^([0-9]{6})$/.exec(text);
  if (direct) return direct[1];
  const command = /^\/auth ([0-9]{6})$/.exec(text);
  return command?.[1];
}

function encodeBase32(bytes: Buffer): string {
  let value = 0;
  let bits = 0;
  let encoded = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      encoded += BASE32[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) encoded += BASE32[(value << (5 - bits)) & 0x1f];
  return encoded;
}

function isEnrollment(value: unknown): value is TotpEnrollment {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    entry.version === 1 &&
    typeof entry.secret === 'string' &&
    typeof entry.ownerId === 'string' &&
    typeof entry.enrolledAt === 'number'
  );
}
