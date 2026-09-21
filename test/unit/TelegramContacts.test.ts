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
    await fs.rm(directory, { recursive: true, force: true });
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

  it('links one private group and answers the approved contact in that group', async () => {
    const value = await fixture();
    await approveAndBind(value);
    const result = await value.service.handleGroup(textEvent('20', 'Πώς είσαι;', GROUP_ID));
    expect(result).toEqual({ kind: 'handled' });

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(value.host.runContactPrompt).toHaveBeenCalledOnce();
    expect(value.host.runContactPrompt).toHaveBeenCalledWith(
      expect.stringContaining('Πώς είσαι;'),
      expect.stringContaining('shared private Telegram group'),
      { web: false },
    );
    expect(value.channel.inlineKeyboards).toHaveLength(0);
    expect(value.channel.sent.filter((item) => item.chatId === GROUP_ID).at(-1)?.text).toBe(
      'Γεια σου!',
    );
    expect(value.contacts.thread(value.contacts.contacts(true)[0]!.id).at(-1)?.role).toBe(
      'assistant',
    );
  });

  it('answers ordinary owner group messages and acknowledges explicit /owner requests in-group', async () => {
    const value = await fixture();
    await approveAndBind(value);
    await expect(
      value.service.handleGroup(textEvent('1', 'Owner answer in the group', GROUP_ID)),
    ).resolves.toEqual({
      kind: 'handled',
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(value.host.runContactPrompt).toHaveBeenCalledOnce();
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
