import { createHmac, timingSafeEqual } from 'crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_MS = 30_000;

/** Decodes the unpadded RFC 4648 Base32 representation used by otpauth URIs. */
export function decodeTotpSecret(secret: string): Buffer {
  const normalized = secret.replace(/=+$/, '').toUpperCase();
  if (!normalized || /[^A-Z2-7]/.test(normalized)) {
    throw new Error('Forge remote TOTP secret is not valid Base32.');
  }

  let value = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const character of normalized) {
    value = (value << 5) | BASE32.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** RFC 6238 (HMAC-SHA1, 30-second timestep) with a caller-selected digit count. */
export function generateTotp(
  secret: string,
  now = Date.now(),
  digits = 6,
): { code: string; step: number } {
  if (!Number.isFinite(now) || now < 0) throw new Error('Forge remote TOTP time is invalid.');
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) {
    throw new Error('Forge remote TOTP digit count is invalid.');
  }
  const step = Math.floor(now / STEP_MS);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', decodeTotpSecret(secret)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return { code: String(binary % 10 ** digits).padStart(digits, '0'), step };
}

/** Returns the accepted timestep, or undefined for an invalid/replayed candidate. */
export function verifyTotp(
  secret: string,
  candidate: string,
  options: {
    now?: number;
    digits?: number;
    skewSteps?: number;
    rejectedSteps?: ReadonlySet<number>;
  } = {},
): number | undefined {
  const now = options.now ?? Date.now();
  const digits = options.digits ?? 6;
  const skewSteps = options.skewSteps ?? 1;
  if (
    !Number.isInteger(digits) ||
    digits < 6 ||
    digits > 8 ||
    !Number.isInteger(skewSteps) ||
    skewSteps < 0 ||
    !new RegExp(`^[0-9]{${digits}}$`).test(candidate)
  ) {
    return undefined;
  }
  const currentStep = Math.floor(now / STEP_MS);
  for (let offset = -skewSteps; offset <= skewSteps; offset++) {
    const step = currentStep + offset;
    if (step < 0 || options.rejectedSteps?.has(step)) continue;
    const expected = generateTotp(secret, step * STEP_MS, digits).code;
    const supplied = Buffer.from(candidate, 'utf8');
    const expectedBytes = Buffer.from(expected, 'utf8');
    if (timingSafeEqual(supplied, expectedBytes)) return step;
  }
  return undefined;
}
