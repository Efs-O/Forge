/**
 * The machine-wide residency-change token's failure paths (BL-032, bug hunt
 * 2026-11-08). A window that frees GPUs for a managed load re-reads residency
 * OUTSIDE the machine-wide lock and trusts this token to tell it whether that map
 * is still current. Two properties this file pins, and that a filesystem-only
 * injection cannot reach:
 *
 *  - when a publication can neither be written nor removed, the old token is still
 *    on disk and readable — and must NOT be the answer, because a reader that got
 *    the old token would trust a map this window knows is stale;
 *  - a later successful publication clears that, since its token cannot match any
 *    earlier read.
 *
 * The failure is injected by mocking the two write paths for the token path alone,
 * so every other file operation in this file runs against the real filesystem.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

const fail = vi.hoisted(() => ({ write: false, remove: false }));

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const remove = real.rmSync as (...args: unknown[]) => unknown;
  return {
    ...real,
    rmSync: (target: unknown, options?: unknown) => {
      if (fail.remove && String(target).endsWith('.residency-generation')) {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      }
      return remove(target, options);
    },
  };
});

vi.mock('../../src/util/atomicWrite', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/util/atomicWrite')>();
  const write = real.writeFileAtomicSync as (...args: unknown[]) => unknown;
  return {
    ...real,
    writeFileAtomicSync: (target: string, content: string | Buffer) => {
      if (fail.write && target.endsWith('.residency-generation')) {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      }
      return write(target, content);
    },
  };
});

import { ExternalTurnHolds } from '../../src/backend/ExternalTurnHolds';

describe('the residency-change token when a publication cannot be made', () => {
  it('answers unknown instead of the old readable token, until a publication succeeds', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-residency-publication-'));
    try {
      const holds = new ExternalTurnHolds(dir, () => true);
      fs.mkdirSync(path.join(dir, 'external-turn-holds'), { recursive: true });
      expect(holds.bumpExternalResidencyGeneration()).toBe(true);
      const token = holds.externalResidencyGeneration();
      expect(token).not.toBe('');

      fail.write = true;
      fail.remove = true;
      // Neither the token nor its removal can be written: the change is lost.
      expect(holds.bumpExternalResidencyGeneration()).toBe(false);
      expect(
        fs.readFileSync(path.join(dir, 'external-turn-holds', '.residency-generation'), 'utf8'),
      ).toBe(token);
      // The old token is still readable, and returning it would be a lie: a reader
      // that trusts it frees nothing on a map this window knows is stale.
      expect(holds.externalResidencyGeneration()).toBe('');

      fail.write = false;
      fail.remove = false;
      // A later success publishes a token no earlier read can match, so honesty
      // here is not permanent conservatism.
      expect(holds.bumpExternalResidencyGeneration()).toBe(true);
      expect(holds.externalResidencyGeneration()).not.toBe('');
      expect(holds.externalResidencyGeneration()).not.toBe(token);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('publishes as unknown — an absent token — when only the write fails', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-residency-publication-'));
    try {
      const holds = new ExternalTurnHolds(dir, () => true);
      fs.mkdirSync(path.join(dir, 'external-turn-holds'), { recursive: true });
      expect(holds.bumpExternalResidencyGeneration()).toBe(true);
      const token = holds.externalResidencyGeneration();
      fail.write = true;
      // The write fails, the removal does not: the file is gone, which every reader
      // already reads as "cannot prove", so this counts as published.
      expect(holds.bumpExternalResidencyGeneration()).toBe(true);
      expect(holds.externalResidencyGeneration()).toBe('');
      expect(holds.externalResidencyGeneration()).not.toBe(token);
    } finally {
      fail.write = false;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
