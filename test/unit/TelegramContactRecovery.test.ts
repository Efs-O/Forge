import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  approveAndBind,
  cleanupTelegramContactFixtures,
  createTelegramContactFixture,
  type ContactPromptRun,
  CONTACT_GROUP_ID,
  textEvent,
  waitForContactRunsToSettle,
} from '../support/telegramContactFixture';

/**
 * Regressions for the 2026-09-21 weekly audit: a contact request interrupted
 * by a reload must be answered after it (A3), and a redelivered Telegram
 * update must not become a second request (A6).
 */

afterEach(async () => {
  await cleanupTelegramContactFixtures();
});

const GROUP_ID = CONTACT_GROUP_ID;
const never: ContactPromptRun = () => new Promise<string>(() => undefined);

describe('contact request recovery (audit A3)', () => {
  it('answers a request whose generation a reload interrupted', async () => {
    const first = await createTelegramContactFixture({
      prefix: 'forge-contact-recovery-',
      run: never,
    });
    await approveAndBind(first);
    await first.service.handleGroup(textEvent('20', 'Τι ώρα είναι;', GROUP_ID));
    // Polled, not a fixed sleep: 50 ms was too short under a loaded full suite.
    await vi.waitFor(() => expect(first.host.runContactPrompt).toHaveBeenCalledOnce());
    first.dispose(); // the window reloads mid-generation

    const second = await createTelegramContactFixture({ directory: first.directory });
    await second.service.recoverInterrupted();
    await vi.waitFor(() =>
      expect(second.channel.sent.at(-1)).toMatchObject({ chatId: GROUP_ID, text: 'Γεια σου!' }),
    );
    await waitForContactRunsToSettle(second);
    expect(second.host.runContactPrompt).toHaveBeenCalledWith(
      expect.stringContaining('Τι ώρα είναι;'),
      expect.any(String),
      { web: false },
    );
    expect((await second.contacts.reclaimUnfinished()).size).toBe(0);
  });

  it('does not re-run a request that was answered before the crash', async () => {
    const first = await createTelegramContactFixture({ prefix: 'forge-contact-recovery-' });
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

    const second = await createTelegramContactFixture({ directory: first.directory });
    await second.service.recoverInterrupted();
    expect(second.host.runContactPrompt).not.toHaveBeenCalled();
    expect((await second.contacts.reclaimUnfinished()).size).toBe(0);
  });

  it('never trims an unanswered request out of the thread', async () => {
    const value = await createTelegramContactFixture({ prefix: 'forge-contact-recovery-' });
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
    const value = await createTelegramContactFixture({ prefix: 'forge-contact-recovery-' });
    await approveAndBind(value);
    const event = textEvent('20', 'hello', GROUP_ID, 'msg-7');
    await value.service.handleGroup(event);
    await value.service.handleGroup({ ...event });
    // The fixture uses burstWindowMs 0, so the burst timer fires on setTimeout(0)
    // and reaching runContactPrompt still costs two file-IO awaits
    // (setDisposition + instructions.load). A fixed 50 ms sleep therefore
    // races the scheduler under suite load and intermittently sees zero calls.
    // Wait for the prompt to run, then assert the count is still exactly one —
    // which is the dedup invariant this test exists for.
    await vi.waitFor(() => expect(value.host.runContactPrompt).toHaveBeenCalled());
    await waitForContactRunsToSettle(value);
    expect(value.host.runContactPrompt).toHaveBeenCalledOnce();
  });

  it('ignores a message redelivered to the next window after a reload', async () => {
    const first = await createTelegramContactFixture({ prefix: 'forge-contact-recovery-' });
    await approveAndBind(first);
    const event = textEvent('20', 'hello', GROUP_ID, 'msg-7');
    await first.service.handleGroup(event);
    await vi.waitFor(() => expect(first.host.runContactPrompt).toHaveBeenCalledOnce());
    await waitForContactRunsToSettle(first);
    const { directory } = first;
    first.dispose();

    const second = await createTelegramContactFixture({ directory });
    await expect(second.service.handleGroup({ ...event })).resolves.toEqual({ kind: 'handled' });
    expect(second.host.runContactPrompt).not.toHaveBeenCalled();
  });
});
