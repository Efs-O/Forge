import { describe, expect, it } from 'vitest';
import { decodeTotpSecret, generateTotp, verifyTotp } from '../../src/remote/RemoteTotp';

const RFC6238_SHA1_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('RemoteTotp', () => {
  it('matches the RFC 6238 SHA-1 test vectors', () => {
    const vectors: Array<[number, string]> = [
      [59, '94287082'],
      [1_111_111_109, '07081804'],
      [1_111_111_111, '14050471'],
      [1_234_567_890, '89005924'],
      [2_000_000_000, '69279037'],
      [20_000_000_000, '65353130'],
    ];
    for (const [seconds, expected] of vectors) {
      expect(generateTotp(RFC6238_SHA1_SECRET, seconds * 1_000, 8).code).toBe(expected);
    }
  });

  it('accepts current and configured adjacent steps, but rejects replayed steps', () => {
    const now = 1_234_567_890_000;
    const current = generateTotp(RFC6238_SHA1_SECRET, now);
    const prior = generateTotp(RFC6238_SHA1_SECRET, now - 30_000);
    expect(verifyTotp(RFC6238_SHA1_SECRET, current.code, { now })).toBe(current.step);
    expect(verifyTotp(RFC6238_SHA1_SECRET, prior.code, { now })).toBe(prior.step);
    expect(
      verifyTotp(RFC6238_SHA1_SECRET, current.code, {
        now,
        rejectedSteps: new Set([current.step]),
      }),
    ).toBeUndefined();
  });

  it('rejects malformed candidates and invalid Base32 enrollment secrets', () => {
    expect(verifyTotp(RFC6238_SHA1_SECRET, '12345x', { now: 0 })).toBeUndefined();
    expect(() => decodeTotpSecret('not a secret')).toThrow('Base32');
  });
});
