import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import {
  handleRemoteJobCommand,
  resetPendingJobDeletes,
  type RemoteJobContext,
} from '../../src/remote/RemoteJobCommands';
import { JobStore } from '../../src/jobs/JobStore';
import { JobSchema, type Job } from '../../src/jobs/jobSchema';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';
import type { RemoteInboundEvent } from '../../src/remote/types';

let root: string;
let store: JobStore;
let channel: FakeRemoteChannel;
let ctx: RemoteJobContext;

function event(text: string): Extract<RemoteInboundEvent, { kind: 'text' }> {
  return { kind: 'text', channel: 'fake', chatId: 'chat-a', text } as Extract<
    RemoteInboundEvent,
    { kind: 'text' }
  >;
}

function job(overrides: Partial<Job> = {}): Job {
  return JobSchema.parse({
    version: 1,
    id: 'disk',
    name: 'Disk',
    enabled: true,
    wake: false,
    after: 'stay_awake',
    schedule: { kind: 'interval', minutes: 15 },
    check: { kind: 'disk_space', path: 'C:\\', min_free_gb: 10 },
    on_change: { kind: 'notify' },
    action: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  });
}

function makeCtx(jobsEnabled = true): RemoteJobContext {
  const host = {} as unknown as ForgeHostFacade;
  return {
    channel,
    host,
    signal: new AbortController().signal,
    store,
    jobsEnabled,
  };
}

async function run(
  line: string,
  ctxOverride?: RemoteJobContext,
): Promise<ReturnType<typeof handleRemoteJobCommand>> {
  const [command, ...operands] = line.trim().split(/\s+/);
  return handleRemoteJobCommand(command, operands, event(line), ctxOverride ?? ctx);
}

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-jobs-remote-'));
  store = new JobStore(root);
  channel = new FakeRemoteChannel();
  ctx = makeCtx();
});

afterEach(async () => {
  resetPendingJobDeletes();
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('/jobs', () => {
  it('reports no jobs when the store is empty', async () => {
    const result = await run('/jobs');
    expect(result).toEqual({ kind: 'handled' });
    expect(channel.sent.at(-1)!.text).toContain('no jobs are defined');
  });

  it('lists each job numbered with its schedule and status', async () => {
    await store.saveJob(job());
    await store.saveJob(job({ id: 'llama', name: 'Llama' }));
    const result = await run('/jobs');
    expect(result).toEqual({ kind: 'handled' });
    const text = channel.sent.at(-1)!.text;
    expect(text).toContain('1. Disk');
    expect(text).toContain('2. Llama');
    expect(text).toContain('every 15 min');
    expect(text).toContain('enabled');
  });

  it('says jobs are not enabled when the config has no jobs block', async () => {
    const result = await run('/jobs', makeCtx(false));
    expect(result).toEqual({ kind: 'handled' });
    expect(channel.sent.at(-1)!.text).toContain('not enabled');
  });
});

describe('/job — pause and resume', () => {
  it('pauses a job by id', async () => {
    await store.saveJob(job());
    const result = await run('/job disk pause');
    expect(result).toEqual({ kind: 'handled' });
    expect(channel.sent.at(-1)!.text).toContain('paused "Disk"');
    expect((await store.load('disk'))?.job.enabled).toBe(false);
  });

  it('resumes a job by number (1-based, as listed by /jobs)', async () => {
    await store.saveJob(job({ enabled: false }));
    const result = await run('/job 1 resume');
    expect(result).toEqual({ kind: 'handled' });
    expect(channel.sent.at(-1)!.text).toContain('resumed "Disk"');
    expect((await store.load('disk'))?.job.enabled).toBe(true);
  });

  it('takes a bare number as the list position, not a substring', async () => {
    // Position wins over substring: job 2 is the second row of /jobs even when
    // the first row's id also contains the number.
    await store.saveJob(job({ id: 'a2', name: 'Beta2', created_at: 0 }));
    await store.saveJob(job({ id: 'disk', name: 'Disk', created_at: 1, enabled: false }));
    const result = await run('/job 2 pause');
    expect(result).toEqual({ kind: 'handled' });
    expect(channel.sent.at(-1)!.text).toContain('paused "Disk"');
    expect((await store.load('disk'))?.job.enabled).toBe(false);
    expect((await store.load('a2'))?.job.enabled).toBe(true);
  });

  it('resolves a case-insensitive name', async () => {
    await store.saveJob(job());
    const result = await run('/job DISK pause');
    expect(result).toEqual({ kind: 'handled' });
    expect((await store.load('disk'))?.job.enabled).toBe(false);
  });

  it('resolves a multi-word name (the action is the final token)', async () => {
    await store.saveJob(job({ id: 'disk-monitor', name: 'Disk Monitor' }));
    const result = await run('/job Disk Monitor pause');
    expect(result).toEqual({ kind: 'handled' });
    expect((await store.load('disk-monitor'))?.job.enabled).toBe(false);
  });

  it('returns the candidates on an ambiguous match', async () => {
    await store.saveJob(job({ id: 'llama-a', name: 'Llama A' }));
    await store.saveJob(job({ id: 'llama-b', name: 'Llama B' }));
    const result = await run('/job llama pause');
    expect(result).toEqual({ kind: 'rejected', reason: 'ambiguous: llama' });
    expect(channel.sent.at(-1)!.text).toContain('ambiguous');
  });

  it('rejects a no match', async () => {
    await store.saveJob(job());
    const result = await run('/job nope pause');
    expect(result).toEqual({ kind: 'rejected', reason: 'no job matches: nope' });
    expect(channel.sent.at(-1)!.text).toContain('no job matches');
  });

  it('rejects a number out of range', async () => {
    await store.saveJob(job());
    const result = await run('/job 5 pause');
    expect(result).toEqual({ kind: 'rejected', reason: 'no job matches: 5' });
  });

  it('rejects an unknown action', async () => {
    await store.saveJob(job());
    const result = await run('/job disk explode');
    expect(result).toEqual({ kind: 'rejected', reason: 'unknown action: explode' });
  });

  it('a bare reference shows the job instead of the usage line', async () => {
    // `/job <id>` is what the `run` reply now points at for the waits it names,
    // so it has to answer with the job. The usage line stays for `/job` with
    // nothing after it.
    await store.saveJob(job());
    const result = await run('/job disk');
    expect(result).toEqual({ kind: 'handled' });
    const text = channel.sent.at(-1)!.text;
    expect(text).toContain('Job "Disk" [disk]');
    expect(text).toContain('schedule: every 15 min');

    const usage = await run('/job');
    expect(usage).toEqual({
      kind: 'rejected',
      reason: 'usage: /job <n|name> pause|resume|run|delete|chat',
    });
  });

  it('the show form names what a waiting job is waiting for', async () => {
    await store.saveJob(job());
    store.patchState('disk', {
      task_pending: true,
      task_pending_reason: 'its own conversation is streaming',
    });

    await run('/job disk');
    expect(channel.sent.at(-1)!.text).toContain(
      'pending: its own conversation is streaming',
    );
  });
});

describe('/job — run', () => {
  it('writes a run_requests marker the scheduler will consume', async () => {
    await store.saveJob(job());
    const result = await run('/job disk run');
    expect(result).toEqual({ kind: 'handled' });
    expect(channel.sent.at(-1)!.text).toContain('run requested for "Disk"');
    expect(fs.existsSync(path.join(root, 'run_requests', 'disk'))).toBe(true);
    const consumed = await store.consumeRunRequests();
    expect(consumed).toEqual(['disk']);
  });

  it('an agent task names the waits it still has to pass', async () => {
    await store.saveJob(job({ action: { kind: 'agent_task', task: 'Tidy the notes folder' } }));

    const result = await run('/job disk run');
    expect(result).toEqual({ kind: 'handled' });
    const text = channel.sent.at(-1)!.text;
    // "the next scheduler tick" alone is only the whole truth for a check: an
    // agent task also waits for the owner's chats to be quiet, and for a GPU
    // when its model is local. The number is `USER_QUIET_MS` divided by a
    // minute, so moving the quiet gate fails here instead of leaving this
    // sentence quietly wrong.
    expect(text).toContain('An agent task also waits until your own chats have been quiet for 10 minutes');
    expect(text).toContain('and for a free GPU when its model is local');
    expect(text).toContain('send /job disk to see what it is waiting for');
  });

  it('a check that is not an agent task claims no agent-task wait', async () => {
    await store.saveJob(job());
    await run('/job disk run');
    expect(channel.sent.at(-1)!.text).not.toContain('agent task');
  });
});

describe('/job — delete', () => {
  it('does not delete on the first message', async () => {
    await store.saveJob(job());
    const result = await run('/job disk delete');
    expect(result).toEqual({ kind: 'handled' });
    expect(channel.sent.at(-1)!.text).toContain('about to delete "Disk"');
    expect(channel.sent.at(-1)!.text).toContain('delete confirm');
    expect(await store.load('disk')).toBeDefined();
  });

  it('deletes after the confirmation', async () => {
    await store.saveJob(job());
    await run('/job disk delete');
    const result = await run('/job disk delete confirm');
    expect(result).toEqual({ kind: 'handled' });
    expect(channel.sent.at(-1)!.text).toContain('deleted "Disk"');
    expect(await store.load('disk')).toBeUndefined();
  });

  it('refuses a confirmation with nothing pending', async () => {
    await store.saveJob(job());
    const result = await run('/job disk delete confirm');
    expect(result).toEqual({
      kind: 'rejected',
      reason: 'nothing to confirm — send /job <n|name> delete first (a confirmation expires after 90s)',
    });
    expect(await store.load('disk')).toBeDefined();
  });

  it('refuses a confirmation for a different job', async () => {
    await store.saveJob(job());
    await store.saveJob(job({ id: 'llama', name: 'Llama' }));
    await run('/job disk delete');
    const result = await run('/job llama delete confirm');
    expect(result).toEqual({
      kind: 'rejected',
      reason: 'nothing to confirm — send /job <n|name> delete first (a confirmation expires after 90s)',
    });
    // Neither job is deleted.
    expect(await store.load('disk')).toBeDefined();
    expect(await store.load('llama')).toBeDefined();
  });

  it('refuses a stale confirmation when the job changed in the window', async () => {
    await store.saveJob(job());
    await run('/job disk delete');
    // The job is updated (bumping updated_at) after the confirmation was offered,
    // as if it were deleted and recreated with the same id.
    const current = (await store.load('disk'))!;
    await store.saveJob({ ...current.job, name: 'Disk v2', updated_at: Date.now() + 1000 });
    const result = await run('/job disk delete confirm');
    expect(result).toEqual({
      kind: 'rejected',
      reason: expect.stringContaining('changed or was removed'),
    });
    // The (replacement) job survives.
    expect(await store.load('disk')).toBeDefined();
  });
});

describe('/job — chat', () => {
  it('opens a new discuss chat and seeds it, persisting the conversation id', async () => {
    await store.saveJob(job());
    const sent: Array<{ conversationId: string; text: string }> = [];
    const host = {
      restoreConversation: async () => {
        throw new Error('no such conversation');
      },
      createConversation: async () => ({ id: 'conv-1' }),
      send: async (conversationId: string, text: string) => {
        sent.push({ conversationId, text });
      },
    } as unknown as ForgeHostFacade;
    const ctxWithHost = { ...ctx, host };
    const result = await run('/job disk chat', ctxWithHost);
    expect(result).toEqual({ kind: 'handled' });
    expect(channel.sent.at(-1)!.text).toContain('opened the discuss chat for "Disk"');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.conversationId).toBe('conv-1');
    expect(sent[0]!.text).toContain('Job "Disk" [disk]');
    expect(sent[0]!.text).toContain('The user wants to discuss this job.');
    // The conversation id is persisted so the next entry point reuses it.
    expect((await store.load('disk'))?.state.conversation_id).toBe('conv-1');
  });

  it('reuses an existing conversation when it still exists', async () => {
    await store.saveJob(job());
    await store.saveState('disk', {
      last_run_at: null,
      last_ok_at: null,
      last_observation: null,
      consecutive_failures: 0,
      next_due_at: null,
      conversation_id: 'conv-existing',
      summary_pending: false,
    });
    const restored: string[] = [];
    const created: string[] = [];
    const host = {
      restoreConversation: async (id: string) => {
        restored.push(id);
      },
      createConversation: async () => {
        created.push('should-not-be-created');
        return { id: 'should-not-be-created' };
      },
      send: async () => undefined,
    } as unknown as ForgeHostFacade;
    const ctxWithHost = { ...ctx, host };
    await run('/job disk chat', ctxWithHost);
    expect(restored).toEqual(['conv-existing']);
    expect(created).toEqual([]);
    expect((await store.load('disk'))?.state.conversation_id).toBe('conv-existing');
  });

  /** The reply must claim a seed only when one was sent: `openDiscussChat`
   *  seeds a chat it has just created and leaves a reused chat alone, so the
   *  wording is picked from the `created` it returns. */
  it('says the chat was seeded, in full, when it was just created', async () => {
    await store.saveJob(job());
    const host = {
      restoreConversation: async () => {
        throw new Error('no such conversation');
      },
      createConversation: async () => ({ id: 'conv-1' }),
      send: async () => undefined,
    } as unknown as ForgeHostFacade;
    const ctxWithHost = { ...ctx, host };

    const result = await run('/job disk chat', ctxWithHost);

    expect(result).toEqual({ kind: 'handled' });
    expect(channel.sent.at(-1)!.text).toBe(
      'Forge: opened the discuss chat for "Disk" [disk]. It is seeded with the job, its recent runs, and the last observation — send a message there to discuss it.',
    );
  });

  it('does not claim a seed, in full, when the chat was reused', async () => {
    await store.saveJob(job());
    store.patchState('disk', { conversation_id: 'conv-existing' });
    const sent: string[] = [];
    const host = {
      restoreConversation: async () => undefined,
      createConversation: async () => ({ id: 'should-not-be-created' }),
      send: async (conversationId: string) => {
        sent.push(conversationId);
      },
    } as unknown as ForgeHostFacade;
    const ctxWithHost = { ...ctx, host };

    const result = await run('/job disk chat', ctxWithHost);

    expect(result).toEqual({ kind: 'handled' });
    expect(sent).toEqual([]);
    expect(channel.sent.at(-1)!.text).toBe(
      'Forge: opened the discuss chat for "Disk" [disk]. It already holds this job\'s discussion, so nothing new was sent — send a message there to continue it.',
    );
  });

  it('returns a clear rejection when opening the chat fails', async () => {
    await store.saveJob(job());
    const host = {
      restoreConversation: async () => {
        throw new Error('no such conversation');
      },
      createConversation: async () => {
        throw new Error('chat limit reached');
      },
      send: async () => undefined,
    } as unknown as ForgeHostFacade;
    const ctxWithHost = { ...ctx, host };
    const result = await run('/job disk chat', ctxWithHost);
    expect(result).toEqual({
      kind: 'rejected',
      reason: 'could not open discuss chat: chat limit reached',
    });
    expect(channel.sent.at(-1)!.text).toContain('could not open the discuss chat');
    expect(channel.sent.at(-1)!.text).toContain('chat limit reached');
  });
});

describe('/job — approve', () => {
  it('reports when there is no staged build to approve', async () => {
    await store.saveJob(job());
    const result = await run('/job disk approve');
    expect(result).toEqual({ kind: 'handled' });
    expect(channel.sent.at(-1)!.text).toContain('no staged build');
  });
});

describe('/job — disabled', () => {
  it('says jobs are not enabled', async () => {
    const result = await run('/job disk pause', makeCtx(false));
    expect(result).toEqual({ kind: 'handled' });
    expect(channel.sent.at(-1)!.text).toContain('not enabled');
  });
});

describe('handleRemoteJobCommand — fallthrough', () => {
  it('returns undefined for a non-job command', async () => {
    const result = await run('/status');
    expect(result).toBeUndefined();
  });
});
