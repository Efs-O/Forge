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

/**
 * Regressions for the 2026-09-21 weekly audit: a contact request interrupted
 * by a reload must be answered after it (A3), and a redelivered Telegram
 * update must not become a second request (A6).
 */

const tempDirs: string[] = [];
const GROUP_ID = '-100200';

class MemorySecrets {
  readonly values = new Map<string, string>([['forge.remote.telegram.ownerId', '1']]);
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

type Run = (prompt: string) => Promise<string>;

/** One Forge "window": a service over the state file in `directory`, loaded fresh. */
async function boot(directory: string, run: Run = async () => 'Γεια σου!') {
  const state = new RemoteRequestStore(path.join(directory, 'state.json'));
  await state.load();
  const channel = new FakeRemoteChannel('telegram');
  const contacts = new RemoteContactStore(state);
  const host = { runContactPrompt: vi.fn(run) };
  const service = new TelegramContactService(
    channel,
    new RemoteAuth(new MemorySecrets() as unknown as vscode.SecretStorage),
    contacts,
    host as unknown as ForgeHostFacade,
    new ContactInstructionsLoader(directory),
    undefined,
    undefined,
    0,
  );
  return { service, channel, contacts, host };
}

async function tempDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-contact-recovery-'));
  tempDirs.push(directory);
  return directory;
}

function textEvent(senderId: string, text: string, chatId = senderId, id?: string) {
  return {
    channel: 'telegram',
    kind: 'text',
    providerMessageId: id ?? `${senderId}-${text}-${chatId}`,
    senderId,
    chatId,
    chatType: chatId === GROUP_ID ? 'group' : 'private',
    ...(chatId === GROUP_ID ? { chatTitle: 'Chara and Forge' } : {}),
    receivedAt: Date.now(),
    text,
  } as Extract<RemoteInboundEvent, { kind: 'text' }>;
}

async function approveAndBind(value: Awaited<ReturnType<typeof boot>>): Promise<string> {
  await value.service.handleNonOwner(textEvent('20', '/start'));
  const pending = value.contacts.pending()[0]!;
  await value.service.handleOwnerCommand(
    textEvent('1', `/contact approve ${pending.id} Chara`),
    value.channel,
  );
  await value.service.handleGroup(textEvent('1', '/contact link Chara', GROUP_ID));
  const link = value.contacts.pendingGroupLink(GROUP_ID)!;
  await value.service.handleOwnerCommand(textEvent('1', `/contact bind ${link.id}`), value.channel);
  return value.contacts.contacts(true)[0]!.id;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));
const never: Run = () => new Promise<string>(() => undefined);

describe('contact request recovery (audit A3)', () => {
  it('answers a request whose generation a reload interrupted', async () => {
    const directory = await tempDir();
    const first = await boot(directory, never);
    await approveAndBind(first);
    await first.service.handleGroup(textEvent('20', 'Τι ώρα είναι;', GROUP_ID));
    // Polled, not a fixed sleep: 50 ms was too short under a loaded full suite.
    await vi.waitFor(() => expect(first.host.runContactPrompt).toHaveBeenCalledOnce());
    first.service.dispose(); // the window reloads mid-generation

    const second = await boot(directory);
    await second.service.recoverInterrupted();
    await vi.waitFor(() =>
      expect(second.channel.sent.at(-1)).toMatchObject({ chatId: GROUP_ID, text: 'Γεια σου!' }),
    );
    expect(second.host.runContactPrompt).toHaveBeenCalledWith(
      expect.stringContaining('Τι ώρα είναι;'),
      expect.any(String),
      { web: false },
    );
    expect((await second.contacts.reclaimUnfinished()).size).toBe(0);
  });

  it('does not re-run a request that was answered before the crash', async () => {
    const directory = await tempDir();
    const first = await boot(directory);
    const contactId = await approveAndBind(first);
    await first.contacts.appendInbound({
      id: 'q1',
      contactId,
      role: 'contact',
      text: 'question',
      createdAt: 1_000,
      inboundKey: 'telegram:x:1',
    });
    await first.contacts.setDisposition(['q1'], 'running');
    await first.contacts.appendThread({
      id: 'a1',
      contactId,
      role: 'assistant',
      text: 'answer',
      createdAt: 2_000,
    });

    const second = await boot(directory);
    await second.service.recoverInterrupted();
    await settle();
    expect(second.host.runContactPrompt).not.toHaveBeenCalled();
    expect((await second.contacts.reclaimUnfinished()).size).toBe(0);
  });

  it('never trims an unanswered request out of the thread', async () => {
    const directory = await tempDir();
    const value = await boot(directory);
    const contactId = await approveAndBind(value);
    await value.contacts.appendInbound({
      id: 'q1',
      contactId,
      role: 'contact',
      text: 'still waiting',
      createdAt: 1,
      inboundKey: 'telegram:x:1',
    });
    for (let i = 0; i < 25; i += 1) {
      await value.contacts.appendThread({
        id: `n${i}`,
        contactId,
        role: 'contact',
        text: `n${i}`,
        createdAt: 10 + i,
      });
    }
    const open = await value.contacts.reclaimUnfinished();
    expect(open.get(contactId)?.map((row) => row.id)).toEqual(['q1']);
  });
});

describe('redelivered Telegram updates (audit A6)', () => {
  it('ignores a redelivered message in the same window', async () => {
    const value = await boot(await tempDir());
    await approveAndBind(value);
    const event = textEvent('20', 'hello', GROUP_ID, 'msg-7');
    await value.service.handleGroup(event);
    await value.service.handleGroup({ ...event });
    await settle();
    expect(value.host.runContactPrompt).toHaveBeenCalledOnce();
  });

  it('ignores a message redelivered to the next window after a reload', async () => {
    const directory = await tempDir();
    const first = await boot(directory);
    await approveAndBind(first);
    const event = textEvent('20', 'hello', GROUP_ID, 'msg-7');
    await first.service.handleGroup(event);
    await settle();
    first.service.dispose();

    const second = await boot(directory);
    await expect(second.service.handleGroup({ ...event })).resolves.toEqual({ kind: 'handled' });
    await settle();
    expect(second.host.runContactPrompt).not.toHaveBeenCalled();
  });
});
