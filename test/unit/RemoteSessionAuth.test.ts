import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { generateTotp } from '../../src/remote/RemoteTotp';
import { RemoteSessionAuth, totpSecretKey } from '../../src/remote/RemoteSessionAuth';
import type { RemoteInboundEvent } from '../../src/remote/types';

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
  onDidChange = () => ({ dispose: () => undefined });
}

function event(text: string): Extract<RemoteInboundEvent, { kind: 'text' }> {
  return {
    channel: 'fake',
    kind: 'text',
    providerMessageId: 'message',
    senderId: 'owner',
    chatId: 'chat',
    chatType: 'private',
    receivedAt: 1,
    text,
  };
}

describe('RemoteSessionAuth', () => {
  it('enrolls locally then strictly consumes an authenticator code before authorization', async () => {
    const secrets = new MemorySecrets();
    const auth = new RemoteSessionAuth(secrets as unknown as vscode.SecretStorage, {
      inactivityTimeoutMinutes: 30,
    });
    const secret = auth.createEnrollmentSecret();
    const now = 1_234_567_890_000;
    const code = generateTotp(secret, now).code;
    await auth.confirmEnrollment('fake', 'owner', secret, code, now);
    expect(secrets.values.get(totpSecretKey('fake'))).not.toContain(code);

    await expect(auth.gate(event('/status'), 'owner', now)).resolves.toEqual({
      kind: 'challenge',
      reason: 'locked',
    });
    await expect(auth.gate(event('123456'), 'owner', now)).resolves.toEqual({ kind: 'failed' });
    const allowed = await auth.gate(event(code), 'owner', now);
    expect(allowed).toMatchObject({ kind: 'authorized', newlyAuthenticated: true });
    expect(await auth.gate(event('/status'), 'owner', now + 1)).toMatchObject({
      kind: 'authorized',
    });
  });

  it('expires inactivity, rejects replay, and permits local-only enrollment removal', async () => {
    const secrets = new MemorySecrets();
    const auth = new RemoteSessionAuth(secrets as unknown as vscode.SecretStorage, {
      inactivityTimeoutMinutes: 1,
    });
    const secret = auth.createEnrollmentSecret();
    const now = 1_234_567_890_000;
    const code = generateTotp(secret, now).code;
    await auth.confirmEnrollment('fake', 'owner', secret, code, now);
    await auth.gate(event(code), 'owner', now);
    expect(auth.canUse('fake', 'owner', 'chat', now + 59_999)).toBe(true);
    expect(auth.canUse('fake', 'owner', 'chat', now + 60_000)).toBe(false);
    await expect(auth.gate(event(code), 'owner', now + 60_000)).resolves.toEqual({ kind: 'failed' });

    await auth.disable('fake', 'owner');
    expect(await auth.isEnrolled('fake', 'owner')).toBe(false);
    await expect(auth.gate(event('/status'), 'owner', now + 60_001)).resolves.toEqual({
      kind: 'authorized',
    });
  });

  it('locks out after five bad authentication candidates and blocks actions while locked', async () => {
    const secrets = new MemorySecrets();
    const auth = new RemoteSessionAuth(secrets as unknown as vscode.SecretStorage, {
      inactivityTimeoutMinutes: 30,
    });
    const secret = auth.createEnrollmentSecret();
    const now = 1_234_567_890_000;
    await auth.confirmEnrollment('fake', 'owner', secret, generateTotp(secret, now).code, now);
    for (let index = 0; index < 4; index++) {
      await expect(auth.gate(event('000000'), 'owner', now + index)).resolves.toEqual({ kind: 'failed' });
    }
    await expect(auth.gate(event('000000'), 'owner', now + 5)).resolves.toEqual({
      kind: 'locked_out',
    });
    await expect(
      auth.gate(
        { ...event(''), kind: 'action', action: 'approve', correlationId: 'approval' },
        'owner',
        now + 6,
      ),
    ).resolves.toEqual({ kind: 'locked_out' });
  });

  it('distinguishes an inactivity expiry from a never-authenticated lock', async () => {
    const secrets = new MemorySecrets();
    const auth = new RemoteSessionAuth(secrets as unknown as vscode.SecretStorage, {
      inactivityTimeoutMinutes: 1,
    });
    const secret = auth.createEnrollmentSecret();
    const now = 1_234_567_890_000;
    await auth.confirmEnrollment('fake', 'owner', secret, generateTotp(secret, now).code, now);

    // Cold session: nothing has expired yet, so the challenge must not blame a timeout.
    await expect(auth.gate(event('do the thing'), 'owner', now)).resolves.toEqual({
      kind: 'challenge',
      reason: 'locked',
    });

    await auth.gate(event(generateTotp(secret, now).code), 'owner', now);
    // Past the inactivity window, the very same prompt now reports an expiry.
    await expect(auth.gate(event('do the thing'), 'owner', now + 60_000)).resolves.toEqual({
      kind: 'challenge',
      reason: 'expired',
    });

    // Re-authenticating clears the expiry, so a later deliberate /lock is not
    // mislabelled as a timeout the user never hit.
    const later = now + 120_000;
    await auth.gate(event(generateTotp(secret, later).code), 'owner', later);
    auth.lock('fake', 'owner');
    await expect(auth.gate(event('do the thing'), 'owner', later + 1)).resolves.toEqual({
      kind: 'challenge',
      reason: 'locked',
    });
  });
});
