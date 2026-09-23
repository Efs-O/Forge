import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { ContactInstructionsLoader } from '../../src/remote/ContactInstructionsLoader';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteAuth } from '../../src/remote/RemoteAuth';
import { RemoteContactStore } from '../../src/remote/RemoteContactStore';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import { TelegramContactService } from '../../src/remote/TelegramContactService';
import type { RemoteInboundEvent } from '../../src/remote/types';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';

const tempDirs: string[] = [];
const GROUP_ID = '-100200';

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

afterEach(async () => {
  for (const directory of tempDirs.splice(0)) {
    // Retried: Windows can still hold a just-closed file (EBUSY).
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

async function fixture(): Promise<{
  service: TelegramContactService;
  channel: FakeRemoteChannel;
  contacts: RemoteContactStore;
  host: { runContactPrompt: ReturnType<typeof vi.fn> };
}> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-contact-test-'));
  tempDirs.push(directory);
  const state = new RemoteRequestStore(path.join(directory, 'state.json'));
  await state.load();
  const secrets = new MemorySecrets();
  await secrets.store('forge.remote.telegram.ownerId', '1');
  const auth = new RemoteAuth(secrets as unknown as vscode.SecretStorage);
  const channel = new FakeRemoteChannel('telegram');
  const contacts = new RemoteContactStore(state);
  const host = { runContactPrompt: vi.fn(async () => 'Γεια σου!') };
  const service = new TelegramContactService(
    channel,
    auth,
    contacts,
    host as unknown as ForgeHostFacade,
    new ContactInstructionsLoader(directory),
    undefined,
    undefined,
    0,
  );
  return { service, channel, contacts, host };
}

function textEvent(
  senderId: string,
  text: string,
  chatId = senderId,
): Extract<RemoteInboundEvent, { kind: 'text' }> {
  return {
    channel: 'telegram',
    kind: 'text',
    providerMessageId: `${senderId}-${text}-${chatId}`,
    senderId,
    chatId,
    chatType: chatId === GROUP_ID ? 'group' : 'private',
    ...(chatId === GROUP_ID ? { chatTitle: 'Chara and Forge' } : {}),
    receivedAt: Date.now(),
    text,
  };
}

async function approveAndBind(value: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  await value.service.handleNonOwner(textEvent('20', '/start'));
  const pending = value.contacts.pending()[0]!;
  await value.service.handleOwnerCommand(textEvent('1', `/contact approve ${pending.id} Chara`));
  const contactId = value.contacts.contacts(true)[0]!.id;
  await value.service.handleGroup(textEvent('1', '/contact link Chara', GROUP_ID));
  const link = value.contacts.pendingGroupLink(GROUP_ID);
  expect(link).toBeDefined();
  await value.service.handleOwnerCommand(textEvent('1', `/contact bind ${link!.id}`));
  expect(value.contacts.byId(contactId)?.groupStatus).toBe('bound');
  return contactId;
}

describe('Telegram contact service', () => {
  it('keeps unknown users out and creates one pending request for /start', async () => {
    const value = await fixture();
    await expect(value.service.handleNonOwner(textEvent('20', '/status'))).resolves.toMatchObject({
      kind: 'rejected',
    });
    await value.service.handleNonOwner(textEvent('20', '/start'));
    await value.service.handleNonOwner(textEvent('20', '/start-again'));
    expect(value.contacts.pending()).toHaveLength(1);
    expect(value.channel.sent.some((item) => item.chatId === '20')).toBe(true);
  });

  it.each(['/start@forgellm_bot', '/start hello', '/START'])(
    'accepts %j as a request for access',
    async (text) => {
      const value = await fixture();
      await value.service.handleNonOwner(textEvent('20', text));
      expect(value.contacts.pending()).toHaveLength(1);
    },
  );

  it('tells a refused stranger how to ask for access, privately and in a group', async () => {
    const value = await fixture();
    // Private: the reason is the one message (acknowledgeTelegramDisposition sends it).
    const privately = await value.service.handleNonOwner(textEvent('20', 'hello'));
    expect(privately).toMatchObject({
      kind: 'rejected',
      reason: expect.stringContaining('send /start'),
    });
    expect(value.contacts.pending()).toHaveLength(0);
    expect(value.channel.sent).toHaveLength(0);
    await value.service.handleGroup(textEvent('20', 'hello', GROUP_ID));
    expect(value.channel.sent.at(-1)?.text).toContain('send /start');
  });

  it('finds a contact approved with a trailing period, with or without accents', async () => {
    const value = await fixture();
    await value.service.handleNonOwner(textEvent('20', '/start'));
    const pending = value.contacts.pending()[0]!;
    await value.service.handleOwnerCommand(textEvent('1', `/contact approve ${pending.id} Χαρά.`));
    expect(value.contacts.contacts(true)[0]!.displayName).toBe('Χαρά');
    for (const name of ['Χαρά', 'χαρα', 'ΧΑΡΑ.']) {
      await value.service.handleGroup(textEvent('1', `/contact link ${name}`, GROUP_ID));
      expect(value.contacts.pendingGroupLink(GROUP_ID)).toBeDefined();
    }
  });

  it('refuses a private owner command once, with the id to use', async () => {
    const value = await fixture();
    const before = value.channel.sent.length;
    const result = await value.service.handleOwnerCommand(textEvent('1', '/contact bind 737154da'));
    expect(result).toMatchObject({
      kind: 'rejected',
      reason: expect.stringContaining('/contact link'),
    });
    expect(value.channel.sent).toHaveLength(before);
  });

  it('links one private group and answers the approved contact in that group', async () => {
    const value = await fixture();
    await approveAndBind(value);
    const result = await value.service.handleGroup(textEvent('20', 'Πώς είσαι;', GROUP_ID));
    expect(result).toEqual({ kind: 'handled' });

    // Polled, not a fixed 50 ms sleep: that flaked under a loaded full suite.
    await vi.waitFor(() => {
      expect(value.channel.sent.filter((item) => item.chatId === GROUP_ID).at(-1)?.text).toBe(
        'Γεια σου!',
      );
      expect(value.contacts.thread(value.contacts.contacts(true)[0]!.id).at(-1)?.role).toBe(
        'assistant',
      );
    });
    expect(value.host.runContactPrompt).toHaveBeenCalledOnce();
    expect(value.host.runContactPrompt).toHaveBeenCalledWith(
      expect.stringContaining('Πώς είσαι;'),
      expect.stringContaining('shared private Telegram group'),
      { web: false },
    );
    expect(value.channel.inlineKeyboards).toHaveLength(0);
  });

  it('answers ordinary owner group messages and acknowledges explicit /owner requests in-group', async () => {
    const value = await fixture();
    await approveAndBind(value);
    await expect(
      value.service.handleGroup(textEvent('1', 'Owner answer in the group', GROUP_ID)),
    ).resolves.toEqual({
      kind: 'handled',
    });
    await vi.waitFor(() => expect(value.host.runContactPrompt).toHaveBeenCalledOnce());
    expect(value.host.runContactPrompt).toHaveBeenCalledWith(
      expect.stringContaining('Owner answer in the group'),
      expect.stringContaining('shared private Telegram group'),
      { web: false },
    );

    await expect(
      value.service.handleGroup(textEvent('20', '/owner I need help', GROUP_ID)),
    ).resolves.toEqual({
      kind: 'handled',
    });
    expect(
      value.channel.sent.some((item) => item.chatId === '1' && item.text.includes('I need help')),
    ).toBe(false);
    expect(value.channel.sent.at(-1)?.text).toBe(
      'The Forge owner can see your message in this group.',
    );
  });

  it('does not allow an approved contact to use the private chat as a second channel', async () => {
    const value = await fixture();
    await approveAndBind(value);
    await expect(
      value.service.handleNonOwner(textEvent('20', 'private question')),
    ).resolves.toMatchObject({
      kind: 'rejected',
    });
    expect(value.host.runContactPrompt).not.toHaveBeenCalled();
    expect(value.channel.sent.at(-1)?.text).toContain('private group');
  });
});
