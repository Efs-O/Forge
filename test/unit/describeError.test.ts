import { describe, it, expect } from 'vitest';
import { describeError, withDescribedCause } from '../../src/util/describeError';

describe('describeError', () => {
  // The reported failure: undici reports every transport fault as this one
  // message and hides the reason in `cause`, so a dead port and a reset socket
  // were indistinguishable by the time either reached Telegram.
  it('names the cause behind a generic fetch failure', () => {
    const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const wrapped = new TypeError('fetch failed', { cause });
    expect(describeError(wrapped)).toBe('fetch failed: read ECONNRESET');
  });

  // undici's timeout errors carry the identifying part only in `code`; the
  // message alone ("Headers Timeout Error") does not say it was undici's.
  it('appends the code when the message does not already carry it', () => {
    const cause = Object.assign(new Error('Headers Timeout Error'), {
      code: 'UND_ERR_HEADERS_TIMEOUT',
    });
    expect(describeError(new TypeError('fetch failed', { cause }))).toBe(
      'fetch failed: Headers Timeout Error (UND_ERR_HEADERS_TIMEOUT)',
    );
  });

  it('walks more than one level', () => {
    const inner = new Error('other side closed');
    const middle = new Error('socket hang up', { cause: inner });
    const outer = new TypeError('fetch failed', { cause: middle });
    expect(describeError(outer)).toBe('fetch failed: socket hang up: other side closed');
  });

  it('does not repeat a cause that restates its parent', () => {
    const cause = new Error('fetch failed');
    expect(describeError(new TypeError('fetch failed', { cause }))).toBe('fetch failed');
  });

  it('stops rather than following a cause cycle forever', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as Error & { cause?: unknown }).cause = b;
    expect(describeError(b)).toBe('b: a');
  });

  it('handles values that are not Errors at all', () => {
    expect(describeError('plain string')).toBe('plain string');
    expect(describeError(undefined)).toBe('unknown error');
    expect(describeError(null)).toBe('unknown error');
  });

  it('falls back to the class name when the message is empty', () => {
    expect(describeError(new TypeError(''))).toBe('TypeError');
  });
});

describe('withDescribedCause', () => {
  it('keeps the original reachable as cause', () => {
    const cause = new Error('read ECONNRESET');
    const original = new TypeError('fetch failed', { cause });
    const rebuilt = withDescribedCause(original);
    expect(rebuilt.message).toBe('fetch failed: read ECONNRESET');
    expect(rebuilt.cause).toBe(original);
  });

  it('returns the same error untouched when there is nothing to add', () => {
    const plain = new Error('already specific');
    expect(withDescribedCause(plain)).toBe(plain);
  });
});
