import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { expect, vi } from 'vitest';
import type * as vscode from 'vscode';
import { ContactInstructionsLoader } from '../../src/remote/ContactInstructionsLoader';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteAuth } from '../../src/remote/RemoteAuth';
import { RemoteContactStore } from '../../src/remote/RemoteContactStore';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import { TelegramContactService } from '../../src/remote/TelegramContactService';
import type { RemoteInboundEvent } from '../../src/remote/types';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';
import { MemorySecrets } from './memorySecrets';

export const CONTACT_GROUP_ID = '-100200';

export type ContactPromptRun = (prompt: string) => Promise<string>;

export interface TelegramContactFixture {
  directory: string;
  service: TelegramContactService;
  channel: FakeRemoteChannel;
  contacts: RemoteContactStore;
  host: { runContactPrompt: ReturnType<typeof vi.fn> };
  dispose(): void;
}

const activeFixtures = new Set<TelegramContactFixture>();
const directories = new Set<string>();

export async function createTelegramContactFixture(options: {
  directory?: string;
  prefix?: string;
  run?: ContactPromptRun;
} = {}): Promise<TelegramContactFixture> {
  const directory =
    options.directory ??
    (await fs.mkdtemp(path.join(os.tmpdir(), options.prefix ?? 'forge-contact-test-')));
  directories.add(directory);
  const state = new RemoteRequestStore(path.join(directory, 'state.json'));
  await state.load();
  const secrets = new MemorySecrets();
  await secrets.store('forge.remote.telegram.ownerId', '1');
  const auth = new RemoteAuth(secrets as unknown as vscode.SecretStorage);
  const channel = new FakeRemoteChannel('telegram');
  const contacts = new RemoteContactStore(state);
  const host = {
    runContactPrompt: vi.fn(options.run ?? (async () => 'Γεια σου!')),
  };
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
  const fixture: TelegramContactFixture = {
    directory,
    service,
    channel,
    contacts,
    host,
    dispose: () => {
      if (activeFixtures.delete(fixture)) service.dispose();
    },
  };
  activeFixtures.add(fixture);
  return fixture;
}

export function textEvent(
  senderId: string,
  text: string,
  chatId = senderId,
  id?: string,
): Extract<RemoteInboundEvent, { kind: 'text' }> {
  return {
    channel: 'telegram',
    kind: 'text',
    providerMessageId: id ?? `${senderId}-${text}-${chatId}`,
    senderId,
    chatId,
    chatType: chatId === CONTACT_GROUP_ID ? 'group' : 'private',
    ...(chatId === CONTACT_GROUP_ID ? { chatTitle: 'Chara and Forge' } : {}),
    receivedAt: Date.now(),
    text,
  };
}

export async function approveAndBind(value: TelegramContactFixture): Promise<string> {
  await value.service.handleNonOwner(textEvent('20', '/start'));
  const pending = value.contacts.pending()[0]!;
  await value.service.handleOwnerCommand(
    textEvent('1', `/contact approve ${pending.id} Chara`),
    value.channel,
  );
  await value.service.handleGroup(textEvent('1', '/contact link Chara', CONTACT_GROUP_ID));
  const link = value.contacts.pendingGroupLink(CONTACT_GROUP_ID)!;
  await value.service.handleOwnerCommand(textEvent('1', `/contact bind ${link.id}`), value.channel);
  return value.contacts.contacts(true)[0]!.id;
}

export async function waitForContactRunsToSettle(
  value: Pick<TelegramContactFixture, 'contacts'>,
): Promise<void> {
  await vi.waitFor(() => {
    const open = value.contacts
      .contacts(true)
      .flatMap((contact) => value.contacts.thread(contact.id, 20))
      .filter((message) => message.disposition === 'pending' || message.disposition === 'running');
    expect(open).toEqual([]);
  });
}

export async function cleanupTelegramContactFixtures(): Promise<void> {
  for (const fixture of activeFixtures) fixture.service.dispose();
  activeFixtures.clear();
  for (const directory of directories) {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
  directories.clear();
}
