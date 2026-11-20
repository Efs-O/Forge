/**
 * The post-wizard local-setup chat (`src/sidebar/localSetupChat.ts`): which
 * picks leave a marker, the exact first message, and the two rules that keep a
 * broken start quiet — clear the marker before opening anything, and refuse a
 * marker that names nothing the chat can walk. The wiring test at the end is
 * the pair that must ship together: a wizard that marks but an activation that
 * never consumes means the user is never walked, and vice versa.
 */
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';
import {
  localSetupExtras,
  localSetupSeed,
  markPendingLocalSetup,
  openPendingLocalSetup,
  PENDING_LOCAL_SETUP_KEY,
  type SetupMemento,
} from '../../src/sidebar/localSetupChat';

type Host = Pick<ForgeHostFacade, 'createConversation' | 'send'>;

/** A memento backed by a Map, recording every `update` call. */
class FakeMemento implements SetupMemento {
  readonly updates: Array<{ key: string; value: unknown }> = [];
  private readonly values = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.updates.push({ key, value });
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
  }

  /** Put a value at the marker key without recording it as an `update`. */
  seedMarker(value: unknown): void {
    this.values.set(PENDING_LOCAL_SETUP_KEY, value);
  }
}

function fakeHost(options: { sendRejects?: boolean } = {}) {
  const createConversation = vi.fn(async () => ({ id: 'c1' }));
  const send = vi.fn(async (..._args: [string, string]) => {
    if (options.sendRejects) throw new Error('send exploded');
    return undefined;
  });
  return {
    host: { createConversation, send } as unknown as Host,
    createConversation,
    send,
  };
}

// The seed, written out here rather than imported: the wording is what the
// user reads, so a change to it has to come with a change to this test.
const INTRO =
  'I just set up Forge with its setup wizard. Help me finish the steps only I can do, one step at a time: tell me the next step, then wait for me to say it is done before the next one. Do not edit any Forge config file: the wizard already wrote it, and the commands below store the secrets. Never ask me to paste a token or a code into this chat.\n';
const TELEGRAM =
  '\nTelegram:\n' +
  '1. In Telegram, open @BotFather, send /newbot, and follow its questions. It answers with a bot token.\n' +
  '2. In VS Code, run Forge: Set Telegram Bot Token from the Command Palette and paste the token there.\n' +
  '3. Run Forge: Pair Telegram Remote and send the code it shows to my new bot.\n' +
  '4. Run Forge: Set Up Telegram Authenticator and add it to an authenticator app.\n' +
  '5. Send my bot a message from my phone and check that Forge answers.\n';
const OTHER =
  '\nOther computer:\n' +
  '1. Install Tailscale on both computers and sign in to the same account on each.\n' +
  '2. Run Forge: Connect to my desktop from the Command Palette, then Forge: Check connection.\n' +
  '3. If the check reports a problem, help me read it. You may run tailscale status to look.\n';
const OUTRO = '\nStart with the first step.';

describe('localSetupExtras', () => {
  it('takes only the extras with human-only steps, in WIZARD_EXTRAS order', () => {
    expect(localSetupExtras(['web-search'])).toEqual([]);
    expect(localSetupExtras([])).toEqual([]);
    expect(localSetupExtras(['other-computer', 'web-search', 'telegram'])).toEqual([
      'telegram',
      'other-computer',
    ]);
  });
});

describe('markPendingLocalSetup', () => {
  it('writes nothing at all when no picked extra needs the chat', async () => {
    const state = new FakeMemento();
    await markPendingLocalSetup(state, ['web-search']);
    await markPendingLocalSetup(state, []);
    expect(state.updates).toEqual([]);
    expect(state.get(PENDING_LOCAL_SETUP_KEY)).toBeUndefined();
  });

  it('stores the marker for a picked extra that does', async () => {
    const state = new FakeMemento();
    await markPendingLocalSetup(state, ['telegram']);
    expect(state.updates).toEqual([
      { key: PENDING_LOCAL_SETUP_KEY, value: { extras: ['telegram'] } },
    ]);
    expect(state.get(PENDING_LOCAL_SETUP_KEY)).toEqual({ extras: ['telegram'] });
  });

  it('lists both extras for both picks, in the fixed order', async () => {
    const state = new FakeMemento();
    await markPendingLocalSetup(state, ['other-computer', 'telegram', 'web-search']);
    expect(state.get(PENDING_LOCAL_SETUP_KEY)).toEqual({
      extras: ['telegram', 'other-computer'],
    });
  });
});

describe('localSetupSeed', () => {
  it('is the intro, the telegram steps and the outro for a telegram-only setup', () => {
    expect(localSetupSeed(['telegram'])).toBe(INTRO + TELEGRAM + OUTRO);
  });

  it('puts every picked section in one fixed order, whatever the input order', () => {
    expect(localSetupSeed(['other-computer', 'telegram'])).toBe(
      INTRO + TELEGRAM + OTHER + OUTRO,
    );
    expect(localSetupSeed(['telegram', 'other-computer'])).toBe(
      INTRO + TELEGRAM + OTHER + OUTRO,
    );
  });

  it('names no command the user did not pick', () => {
    const telegramOnly = localSetupSeed(['telegram']);
    expect(telegramOnly).toBe(INTRO + TELEGRAM + OUTRO);
    expect(telegramOnly).not.toContain('Tailscale');
    const otherOnly = localSetupSeed(['other-computer']);
    expect(otherOnly).toBe(INTRO + OTHER + OUTRO);
    expect(otherOnly).not.toContain('BotFather');
  });
});

describe('openPendingLocalSetup', () => {
  it('opens one activated chat, sends the seed, and clears the marker', async () => {
    const state = new FakeMemento();
    state.seedMarker({ extras: ['telegram'] });
    const { host, createConversation, send } = fakeHost();

    await expect(openPendingLocalSetup(state, host)).resolves.toBe('c1');

    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(createConversation).toHaveBeenCalledWith({ activate: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe('c1');
    expect(send.mock.calls[0]?.[1]).toBe(INTRO + TELEGRAM + OUTRO);
    expect(state.get(PENDING_LOCAL_SETUP_KEY)).toBeUndefined();
  });

  it('clears the marker before it opens anything, so a failure cannot reopen it', async () => {
    const state = new FakeMemento();
    state.seedMarker({ extras: ['telegram'] });
    const first = fakeHost({ sendRejects: true });

    await expect(openPendingLocalSetup(state, first.host)).rejects.toThrow('send exploded');
    expect(state.get(PENDING_LOCAL_SETUP_KEY)).toBeUndefined();

    const second = fakeHost();
    await expect(openPendingLocalSetup(state, second.host)).resolves.toBeUndefined();
    expect(second.createConversation).not.toHaveBeenCalled();
    expect(first.send).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all when there is no marker', async () => {
    const state = new FakeMemento();
    const { host, createConversation } = fakeHost();

    await expect(openPendingLocalSetup(state, host)).resolves.toBeUndefined();

    expect(state.updates).toEqual([]);
    expect(createConversation).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty list', { extras: [] }],
    ['an extra the chat cannot walk', { extras: ['web-search'] }],
    ['a bare string', 'telegram'],
    ['an object without extras', {}],
  ])('refuses a marker holding %s, but still clears it', async (_name, value) => {
    const state = new FakeMemento();
    state.seedMarker(value);
    const { host, createConversation } = fakeHost();

    await expect(openPendingLocalSetup(state, host)).resolves.toBeUndefined();

    expect(createConversation).not.toHaveBeenCalled();
    expect(state.updates).toEqual([{ key: PENDING_LOCAL_SETUP_KEY, value: undefined }]);
    expect(state.get(PENDING_LOCAL_SETUP_KEY)).toBeUndefined();
  });
});

describe('wiring', () => {
  it('marks in the wizard and consumes in activation, in the same build', () => {
    const root = path.resolve(__dirname, '..', '..');
    const wizard = fs.readFileSync(
      path.join(root, 'src', 'sidebar', 'FirstRunWizard.ts'),
      'utf8',
    );
    const extension = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
    expect(wizard).toContain('markPendingLocalSetup(context.globalState');
    expect(extension).toContain('openPendingLocalSetup(context.globalState');
  });
});
