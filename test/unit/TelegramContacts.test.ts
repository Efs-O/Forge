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
  const channel = new FakeRemoteChannel();
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

function textEvent(senderId: string, text: string): Extract<RemoteInboundEvent, { kind: 'text' }> {
  return {
    channel: 'telegram',
    kind: 'text',
    providerMessageId: `${senderId}-${text}`,
    senderId,
    chatId: senderId,
    chatType: 'private',
    receivedAt: Date.now(),
    text,
  };
}

async function approveContact(fixtureValue: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  await fixtureValue.service.handleNonOwner(textEvent('20', '/start'));
  const pending = fixtureValue.contacts.pending()[0]!;
  await fixtureValue.service.handleOwnerCommand(
    textEvent('1', `/contact approve ${pending.id} Chara`),
  );
  return fixtureValue.contacts.contacts(true)[0]!.id;
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

  it('coalesces a contact request, previews the exact answer, and sends once after confirmation', async () => {
    const value = await fixture();
    await approveContact(value);
    const result = await value.service.handleNonOwner(textEvent('20', 'Πώς είσαι;'));
    expect(result).toEqual({ kind: 'handled' });
    expect(value.host.runContactPrompt).not.toHaveBeenCalled();

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(value.host.runContactPrompt).toHaveBeenCalledOnce();
    expect(value.channel.inlineKeyboards).toHaveLength(1);
    const keyboard = value.channel.inlineKeyboards[0]!;
    const callbackData = keyboard.buttons[0]![0]!.callbackData;
    const correlationId = callbackData.slice(2, -2);
    const callback: Extract<RemoteInboundEvent, { kind: 'contact_action' }> = {
      channel: 'telegram',
      kind: 'contact_action',
      providerMessageId: 'callback-1',
      senderId: '1',
      chatId: '1',
      chatType: 'private',
      receivedAt: Date.now(),
      action: 'send',
      correlationId,
      messageId: 'keyboard-1',
    };
    await expect(value.service.handleAction(callback)).resolves.toEqual({ kind: 'handled' });
    expect(value.channel.sent.filter((item) => item.chatId === '20')).toHaveLength(3);
    await expect(value.service.handleAction(callback)).resolves.toMatchObject({ kind: 'rejected' });
    expect(value.channel.sent.filter((item) => item.chatId === '20')).toHaveLength(3);
  });

  it('does not run owner commands or generation for an approved contact', async () => {
    const value = await fixture();
    await approveContact(value);
    await value.service.handleNonOwner(textEvent('20', '/contacts list'));
    expect(value.host.runContactPrompt).not.toHaveBeenCalled();
    expect(value.channel.sent.at(-1)?.text).toContain('private');
  });
});
