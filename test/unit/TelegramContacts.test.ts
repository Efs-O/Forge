import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import {
  approveAndBind,
  cleanupTelegramContactFixtures,
  createTelegramContactFixture,
  CONTACT_GROUP_ID,
  textEvent,
  waitForContactRunsToSettle,
} from '../support/telegramContactFixture';

afterEach(async () => {
  await cleanupTelegramContactFixtures();
});

const GROUP_ID = CONTACT_GROUP_ID;

describe('Telegram contact service', () => {
  it('keeps unknown users out and creates one pending request for /start', async () => {
    const value = await createTelegramContactFixture();
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
      const value = await createTelegramContactFixture();
      await value.service.handleNonOwner(textEvent('20', text));
      expect(value.contacts.pending()).toHaveLength(1);
    },
  );

  it('tells a refused stranger how to ask for access, privately and in a group', async () => {
    const value = await createTelegramContactFixture();
    // Private: the reason is the one message (acknowledgeTelegramDisposition sends it).
    const privately = await value.service.handleNonOwner(textEvent('20', 'hello'));
    expect(privately).toMatchObject({
      kind: 'rejected',
      reason: expect.stringContaining('send /start'),
    });
    expect(privately).not.toHaveProperty('ephemeral');
    expect(value.contacts.pending()).toHaveLength(0);
    expect(value.channel.sent).toHaveLength(0);
    await value.service.handleGroup(textEvent('20', 'hello', GROUP_ID));
    expect(value.channel.sent.at(-1)?.text).toContain('send /start');
  });

  it('finds a contact approved with a trailing period, with or without accents', async () => {
    const value = await createTelegramContactFixture();
    await value.service.handleNonOwner(textEvent('20', '/start'));
    const pending = value.contacts.pending()[0]!;
    await value.service.handleOwnerCommand(
      textEvent('1', `/contact approve ${pending.id} Χαρά.`),
      value.channel,
    );
    expect(value.contacts.contacts(true)[0]!.displayName).toBe('Χαρά');
    for (const name of ['Χαρά', 'χαρα', 'ΧΑΡΑ.']) {
      await value.service.handleGroup(textEvent('1', `/contact link ${name}`, GROUP_ID));
      expect(value.contacts.pendingGroupLink(GROUP_ID)).toBeDefined();
    }
  });

  it('refuses a private owner command once, on the reply channel, with the id to use', async () => {
    const value = await createTelegramContactFixture();
    const reply = new FakeRemoteChannel('telegram');
    const before = value.channel.sent.length;
    const result = await value.service.handleOwnerCommand(
      textEvent('1', '/contact bind 737154da'),
      reply,
    );
    // Handled, not rejected: a rejected reason is re-sent by the acknowledgement
    // layer, outside the reply channel whose messages are deleted after a delay.
    expect(result).toEqual({ kind: 'handled' });
    expect(reply.sent).toHaveLength(1);
    expect(reply.sent[0]!.text).toContain('/contact link');
    expect(value.channel.sent).toHaveLength(before);
  });

  it('links one private group and answers the approved contact in that group', async () => {
    const value = await createTelegramContactFixture();
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
    await waitForContactRunsToSettle(value);
    expect(value.host.runContactPrompt).toHaveBeenCalledOnce();
    expect(value.host.runContactPrompt).toHaveBeenCalledWith(
      expect.stringContaining('Πώς είσαι;'),
      expect.stringContaining('shared private Telegram group'),
      { web: false },
    );
    expect(value.channel.inlineKeyboards).toHaveLength(0);
  });

  it('answers ordinary owner group messages and acknowledges explicit /owner requests in-group', async () => {
    const value = await createTelegramContactFixture();
    await approveAndBind(value);
    await expect(
      value.service.handleGroup(textEvent('1', 'Owner answer in the group', GROUP_ID)),
    ).resolves.toEqual({
      kind: 'handled',
    });
    await vi.waitFor(() => expect(value.host.runContactPrompt).toHaveBeenCalledOnce());
    await waitForContactRunsToSettle(value);
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
    const value = await createTelegramContactFixture();
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
