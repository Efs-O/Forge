import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FILE_DELIVERY_TURN_LIMIT,
  NOTIFY_IDLE_RESET_MS,
  NOTIFY_TURN_LIMIT,
  UserNotificationService,
} from '../../src/sidebar/UserNotificationService';
import { makeNotifyUserTool } from '../../src/tools/uxTools';
import { readOutboxItem, writeOutboxItem } from '../../src/jobs/JobOutbox';
import { unattendedConversations } from '../../src/sidebar/unattendedConversations';

const unattendedOutboxDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    unattendedOutboxDirs.splice(0).map((directory) => fs.promises.rm(directory, { recursive: true, force: true })),
  );
});

describe('UserNotificationService', () => {
  it('sums the chat counts reported by every sink', async () => {
    const service = new UserNotificationService();
    service.addSink(async () => 2);
    service.addSink(async () => 1);
    expect(await service.notify({ conversationId: 'c1', text: 'hi' })).toBe(3);
  });

  it('reports zero when nothing is bound', async () => {
    const service = new UserNotificationService();
    expect(await service.notify({ conversationId: 'c1', text: 'hi' })).toBe(0);
  });

  // One broken transport must not take down a notification the other sinks --
  // and the unconditional VS Code toast -- can still deliver.
  it('counts a throwing sink as zero, reports it, and does not reject', async () => {
    const onSinkError = vi.fn();
    const service = new UserNotificationService(onSinkError);
    service.addSink(async () => {
      throw new Error('transport down');
    });
    service.addSink(async () => 4);
    expect(await service.notify({ conversationId: 'c1', text: 'hi' })).toBe(4);
    expect(onSinkError).toHaveBeenCalledOnce();
    expect(onSinkError.mock.calls[0]?.[0]).toContain('transport down');
  });

  it('stops offering budget after the per-turn limit', async () => {
    const service = new UserNotificationService();
    service.addSink(async () => 1);
    for (let i = 0; i < NOTIFY_TURN_LIMIT; i += 1) {
      expect(service.remaining('c1')).toBeGreaterThan(0);
      await service.notify({ conversationId: 'c1', text: `m${i}` });
    }
    expect(service.remaining('c1')).toBe(0);
  });

  it('budgets each conversation separately', async () => {
    const service = new UserNotificationService();
    service.addSink(async () => 1);
    for (let i = 0; i < NOTIFY_TURN_LIMIT; i += 1) {
      await service.notify({ conversationId: 'c1', text: 'm' });
    }
    expect(service.remaining('c1')).toBe(0);
    expect(service.remaining('c2')).toBe(NOTIFY_TURN_LIMIT);
  });

  // Reset happens on turn START. A turn that throws or is cancelled never
  // reaches its end, so an end-keyed counter would leak and silently mute the
  // agent for every later turn in that conversation.
  it('clears the budget when the next turn starts', async () => {
    const service = new UserNotificationService();
    service.addSink(async () => 1);
    for (let i = 0; i < NOTIFY_TURN_LIMIT; i += 1) {
      await service.notify({ conversationId: 'c1', text: 'm' });
    }
    expect(service.remaining('c1')).toBe(0);
    service.resetTurn('c1');
    expect(service.remaining('c1')).toBe(NOTIFY_TURN_LIMIT);
    expect(await service.notify({ conversationId: 'c1', text: 'again' })).toBe(1);
  });

  // PromptRun fires onGenerationStarted with no conversationId -- a /compact
  // summary is not the user's turn and must not refill a real turn's budget.
  it('does not clear a conversation budget on a conversation-less turn start', async () => {
    const service = new UserNotificationService();
    service.addSink(async () => 1);
    for (let i = 0; i < NOTIFY_TURN_LIMIT; i += 1) {
      await service.notify({ conversationId: 'c1', text: 'm' });
    }
    service.resetTurn(undefined);
    expect(service.remaining('c1')).toBe(0);
  });

  // ...but the CONVERSATION-LESS bucket must still drain. extension.ts calls
  // resetTurn unconditionally; guarded on a defined id, a notify_user or
  // send_file run with no conversation would fill that bucket once and never
  // empty it, muting those tools for the rest of the session.
  it('clears the conversation-less bucket on a conversation-less turn start', async () => {
    const service = new UserNotificationService();
    service.addSink(async () => 1);
    for (let i = 0; i < NOTIFY_TURN_LIMIT; i += 1) {
      await service.notify({ text: 'm' });
    }
    expect(service.remaining(undefined)).toBe(0);
    service.resetTurn(undefined);
    expect(service.remaining(undefined)).toBe(NOTIFY_TURN_LIMIT);
    for (let i = 0; i < FILE_DELIVERY_TURN_LIMIT; i += 1) {
      await service.deliverFile({ text: 'f', imagePath: 'C:/workspace/f.pdf' });
    }
    expect(service.remainingFileDeliveries(undefined)).toBe(0);
    service.resetTurn(undefined);
    expect(service.remainingFileDeliveries(undefined)).toBe(FILE_DELIVERY_TURN_LIMIT);
  });

  it('stops fanning out to a disposed sink', async () => {
    const service = new UserNotificationService();
    const subscription = service.addSink(async () => 5);
    expect(await service.notify({ conversationId: 'c1', text: 'a' })).toBe(5);
    subscription.dispose();
    expect(await service.notify({ conversationId: 'c1', text: 'b' })).toBe(0);
  });
});

describe('deliverFile per-turn file budget', () => {
  const fileEvent = (conversationId: string) => ({
    conversationId,
    text: 'caption',
    imagePath: 'C:/workspace/report.pdf',
  });

  it('queues up to the limit and refuses the next one, naming the reason', async () => {
    const service = new UserNotificationService();
    service.addSink(async () => 1);
    for (let i = 0; i < FILE_DELIVERY_TURN_LIMIT; i += 1) {
      expect(service.remainingFileDeliveries('c1')).toBeGreaterThan(0);
      const result = await service.deliverFile(fileEvent('c1'));
      expect(result.kind).toBe('queued');
    }
    expect(service.remainingFileDeliveries('c1')).toBe(0);
    const capped = await service.deliverFile(fileEvent('c1'));
    expect(capped.kind).toBe('refused');
    if (capped.kind === 'refused') {
      expect(capped.spentThisTurn).toBe(FILE_DELIVERY_TURN_LIMIT);
      expect(capped.reason).toContain('File delivery limit reached');
      // The refusal must point at the alternative, and name the real path --
      // a screenshot-dir file is not in the workspace.
      expect(capped.reason).toContain('still on disk at');
      expect(capped.reason).toContain('C:/workspace/report.pdf');
    }
  });

  // Codex review of Phase 1: the check and the charge are safe only because
  // they run synchronously before the first await. Pin that against a future
  // refactor that puts an await between them -- six concurrent calls against a
  // blocked sink must land exactly five sends and one refusal.
  it('accepts exactly the limit under concurrent calls', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const service = new UserNotificationService();
    service.addSink(async () => {
      await gate;
      return 1;
    });
    const calls = Array.from({ length: FILE_DELIVERY_TURN_LIMIT + 1 }, () =>
      service.deliverFile(fileEvent('c1')),
    );
    release();
    const results = await Promise.all(calls);
    expect(results.filter((result) => result.kind === 'queued')).toHaveLength(
      FILE_DELIVERY_TURN_LIMIT,
    );
    expect(results.filter((result) => result.kind === 'refused')).toHaveLength(1);
  });

  // The send is queued BEFORE the count matters to the caller: a turn with no
  // chat bound still spends the slot, so "no chat is watching" cannot be farmed
  // for unlimited fan-out attempts.
  it('reports 0 chats but still charges the budget when nothing is bound', async () => {
    const service = new UserNotificationService();
    for (let i = 0; i < FILE_DELIVERY_TURN_LIMIT; i += 1) {
      const result = await service.deliverFile(fileEvent('c1'));
      expect(result).toEqual({ kind: 'queued', chats: 0 });
    }
    expect((await service.deliverFile(fileEvent('c1'))).kind).toBe('refused');
  });

  // CI-enforced ledger row: the counter lives in the service, cleared by the
  // existing resetTurn. A counter in a tool closure has no reset path and would
  // mute the tool for the rest of the session.
  it('does not leak the file budget across turns', async () => {
    const service = new UserNotificationService();
    service.addSink(async () => 1);
    for (let i = 0; i < FILE_DELIVERY_TURN_LIMIT + 3; i += 1) {
      await service.deliverFile(fileEvent('c1'));
    }
    expect(service.remainingFileDeliveries('c1')).toBe(0);
    service.resetTurn('c1');
    expect(service.remainingFileDeliveries('c1')).toBe(FILE_DELIVERY_TURN_LIMIT);
    expect(await service.deliverFile(fileEvent('c1'))).toEqual({ kind: 'queued', chats: 1 });
  });

  it('budgets each conversation separately', async () => {
    const service = new UserNotificationService();
    service.addSink(async () => 1);
    for (let i = 0; i < FILE_DELIVERY_TURN_LIMIT; i += 1) {
      await service.deliverFile(fileEvent('c1'));
    }
    expect(service.remainingFileDeliveries('c1')).toBe(0);
    expect(service.remainingFileDeliveries('c2')).toBe(FILE_DELIVERY_TURN_LIMIT);
  });

  // One counter for both tools (send_file + render_html_to_image): the cap is
  // on what the phone receives, not on which tool made the bytes.
  it('shares one counter across every budgeted delivery', async () => {
    const service = new UserNotificationService();
    service.addSink(async () => 1);
    await service.deliverFile(fileEvent('c1')); // send_file
    await service.deliverFile(fileEvent('c1')); // render_html_to_image
    expect(service.remainingFileDeliveries('c1')).toBe(FILE_DELIVERY_TURN_LIMIT - 2);
  });

  // The two brakes answer different questions, so spending one must not mute
  // the other: five files must not cost the turn its ability to notify.
  it('keeps the notify budget intact when the file budget is spent', async () => {
    const service = new UserNotificationService();
    service.addSink(async () => 1);
    for (let i = 0; i < FILE_DELIVERY_TURN_LIMIT; i += 1) {
      await service.deliverFile(fileEvent('c1'));
    }
    expect(service.remainingFileDeliveries('c1')).toBe(0);
    expect(service.remaining('c1')).toBe(NOTIFY_TURN_LIMIT);
    expect(await service.notify({ conversationId: 'c1', text: 'still allowed' })).toBe(1);
  });

  // generate_image must explicitly name its per-call approval brake.
  it('leaves confirm_each image delivery unbudgeted', async () => {
    const service = new UserNotificationService();
    service.addSink(async () => 1);
    for (let i = 0; i < FILE_DELIVERY_TURN_LIMIT + 5; i += 1) {
      expect(await service.deliverImageUnbudgeted('confirm_each', fileEvent('c1'))).toBe(1);
    }
    expect(service.remainingFileDeliveries('c1')).toBe(FILE_DELIVERY_TURN_LIMIT);
  });

  // Unlike notify, the file budget has no idle refill. Pin that, so a later
  // "consistency" change to add one is a decision rather than an accident.
  it('does not refill the file budget on quiet time', async () => {
    let clock = 0;
    const service = new UserNotificationService(undefined, () => clock);
    service.addSink(async () => 1);
    for (let i = 0; i < FILE_DELIVERY_TURN_LIMIT; i += 1) {
      await service.deliverFile(fileEvent('c1'));
    }
    clock += NOTIFY_IDLE_RESET_MS * 2;
    expect(service.remainingFileDeliveries('c1')).toBe(0);
    // ...while the notify budget does refill, which is the difference.
    expect(service.remaining('c1')).toBe(NOTIFY_TURN_LIMIT);
  });
});

describe('notify_user tool', () => {
  it('names the remote chats it reached', async () => {
    const service = new UserNotificationService();
    service.addSink(async () => 2);
    const tool = makeNotifyUserTool(service);
    const result = await tool.handler({ message: 'build done' }, ctx('c1'));
    expect(result).toBe('Message delivered to the VS Code window and 2 remote chat(s).');
  });

  // The ask_user lesson: a tool that reports success into a void teaches the
  // model to claim it notified a user whose phone never buzzed.
  it('states plainly that nothing reached the user remotely', async () => {
    const service = new UserNotificationService();
    const tool = makeNotifyUserTool(service);
    const result = await tool.handler({ message: 'build done' }, ctx('c1'));
    expect(result).toContain('did NOT receive it on their phone');
    expect(result).toContain('Do not claim you notified them remotely');
  });

  it('writes an unattended notification to the job outbox', async () => {
    const service = new UserNotificationService();
    const outboxDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-unattended-'));
    unattendedOutboxDirs.push(outboxDir);
    const marker = unattendedConversations.mark('unattended-notification');
    try {
      const tool = makeNotifyUserTool(
        service,
        unattendedConversations,
        (conversationId, jobMeta, message) =>
          writeOutboxItem(
            outboxDir,
            jobMeta?.jobId ?? conversationId,
            jobMeta?.jobName ?? 'Llama job',
            message,
            123,
          ),
      );
      const result = await tool.handler(
        { message: 'the install needs attention' },
        { beforeMutate: () => undefined, conversationId: 'unattended-notification' },
      );
      const item = await readOutboxItem(outboxDir, 'unattended-notification');
      expect(item?.text).toBe('the install needs attention');
      expect(result).toContain('job outbox');
    } finally {
      marker.dispose();
    }
  });

  // AC10: a job run's notify_user writes under the job id with the job name,
  // not the conversation id — one coalesced outbox item per job.
  it('writes an unattended job notification under the job id with the job name', async () => {
    const service = new UserNotificationService();
    const outboxDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-unattended-'));
    unattendedOutboxDirs.push(outboxDir);
    const marker = unattendedConversations.mark('job-conv-1', {
      jobId: 'llama-updates',
      jobName: 'Keep llama.cpp current',
    });
    try {
      const tool = makeNotifyUserTool(
        service,
        unattendedConversations,
        (conversationId, jobMeta, message) =>
          writeOutboxItem(
            outboxDir,
            jobMeta?.jobId ?? conversationId,
            jobMeta?.jobName ?? 'Unattended conversation',
            message,
            123,
          ),
      );
      await tool.handler(
        { message: 'install in progress' },
        { beforeMutate: () => undefined, conversationId: 'job-conv-1' },
      );
      // Under the job id, not the conversation id.
      const item = await readOutboxItem(outboxDir, 'llama-updates');
      expect(item?.text).toBe('install in progress');
      expect(item?.name).toBe('Keep llama.cpp current');
      expect(await readOutboxItem(outboxDir, 'job-conv-1')).toBeUndefined();
    } finally {
      marker.dispose();
    }
  });

  it('refuses past the burst cap and names the alternative', async () => {
    const service = new UserNotificationService();
    service.addSink(async () => 1);
    const tool = makeNotifyUserTool(service);
    for (let i = 0; i < NOTIFY_TURN_LIMIT; i += 1) {
      await tool.handler({ message: `m${i}` }, ctx('c1'));
    }
    const capped = await tool.handler({ message: 'one too many' }, ctx('c1'));
    expect(capped).toContain(`Notification limit reached: ${NOTIFY_TURN_LIMIT} sent`);
    expect(capped).toContain('put this message in your final reply instead');
    // The refusal has to say the budget comes back, or a paced run reads the
    // cap as final and goes silent for the rest of the turn.
    expect(capped).toContain('refills');
  });

  // The overnight-report failure: an 8-hour run is one turn, so a per-turn cap
  // with no refill silences a 2-hour cadence after its fourth report.
  it('returns the whole budget after a quiet stretch', async () => {
    let clock = 0;
    const service = new UserNotificationService(undefined, () => clock);
    service.addSink(async () => 1);
    const tool = makeNotifyUserTool(service);
    for (let i = 0; i < NOTIFY_TURN_LIMIT; i += 1) {
      await tool.handler({ message: `m${i}` }, ctx('c1'));
    }
    expect(service.remaining('c1')).toBe(0);

    // One second short of the window: still capped, and the refusal says how
    // much longer to wait rather than implying the turn must end first.
    clock += NOTIFY_IDLE_RESET_MS - 1000;
    const early = await tool.handler({ message: 'too soon' }, ctx('c1'));
    expect(early).toContain('Notification limit reached');
    expect(service.idleResetIn('c1')).toBe(1000);

    // A refused call must not push the window out, or a retrying agent could
    // never reach the reset it is waiting for.
    clock += 1000;
    expect(service.remaining('c1')).toBe(NOTIFY_TURN_LIMIT);
    expect(await tool.handler({ message: 'report 2' }, ctx('c1'))).toContain('delivered');
    // ...and the send that follows the reset starts a fresh burst, rather than
    // landing on the stale total and capping again immediately.
    expect(service.remaining('c1')).toBe(NOTIFY_TURN_LIMIT - 1);
  });

  it('reports remote reach without sending, and 0 when no probe is registered', () => {
    const service = new UserNotificationService();
    expect(service.reach('c1')).toBe(0);
    const registration = service.setReachProbe((id) => (id === 'c1' ? 2 : 0));
    expect(service.reach('c1')).toBe(2);
    expect(service.reach('c2')).toBe(0);
    expect(service.reach(undefined)).toBe(0);
    // Disposed with the transport: a count that outlived it would tell a turn
    // the user was reachable when nothing could deliver.
    registration.dispose();
    expect(service.reach('c1')).toBe(0);
  });

  it('reports reach 0 when the probe throws rather than failing the turn', () => {
    const service = new UserNotificationService();
    service.setReachProbe(() => {
      throw new Error('transport down');
    });
    expect(service.reach('c1')).toBe(0);
  });

  it('does not consume budget for a call it refused', async () => {
    const service = new UserNotificationService();
    service.addSink(async () => 1);
    const tool = makeNotifyUserTool(service);
    for (let i = 0; i < NOTIFY_TURN_LIMIT + 3; i += 1) {
      await tool.handler({ message: 'm' }, ctx('c1'));
    }
    service.resetTurn('c1');
    expect(await tool.handler({ message: 'fresh turn' }, ctx('c1'))).toContain('delivered');
  });

  it('takes no free-form blob arg', () => {
    const schema = makeNotifyUserTool(new UserNotificationService()).definition.function.parameters;
    expect(schema).toMatchObject({
      required: ['message'],
      additionalProperties: false,
    });
    expect(Object.keys((schema as { properties: object }).properties)).toEqual(['message']);
  });
});

function ctx(conversationId: string) {
  return { beforeMutate: () => {}, conversationId };
}
