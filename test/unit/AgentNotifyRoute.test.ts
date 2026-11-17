/**
 * `forge.sh notify`: an agent's Telegram message to the owner.
 *
 * What is pinned here is the three things the route exists to guarantee: the
 * outbox key can never be taken by a job's delete, a config that would leave
 * the message undelivered is refused with the reason instead of queueing it in
 * silence, and the coalescing rules a waiting Telegram window relies on are the
 * same ones an agent's notify gets.
 *
 * Every write goes to a temporary directory: no test may touch the real
 * `~/.forge`, whose outbox the running window is watching.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_NOTIFY_MAX_CHARS,
  agentNotifyKey,
  handleAgentNotifyRoute,
  makeNotifyOwner,
  notifyRefusal,
  type AgentNotifyResult,
} from '../../src/backend/agentNotifyRoute';
import { AgentRouteHttpError } from '../../src/backend/agentRouteFields';
import type { ForgeConfig } from '../../src/config/types';
import type { OutboxItem } from '../../src/jobs/JobOutbox';
import { jobSlug } from '../../src/jobs/jobId';

const TELEGRAM_OFF =
  'Telegram is off in this Forge (remote.enabled and remote.telegram.enabled), so nothing would deliver this. Nothing was queued.';
const JOBS_OFF =
  'jobs.enabled is off in this Forge, so no window delivers the notify outbox. Nothing was queued.';

type NotifyConfig = Pick<ForgeConfig, 'remote' | 'jobs'>;

function config(
  remoteEnabled: boolean,
  telegramEnabled: boolean,
  jobsEnabled: boolean,
): NotifyConfig {
  return {
    remote: { enabled: remoteEnabled, telegram: { enabled: telegramEnabled } } as NotifyConfig['remote'],
    jobs: { enabled: jobsEnabled } as NotifyConfig['jobs'],
  };
}

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-notify-route-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const ALL_ON = config(true, true, true);

describe('the notify outbox key', () => {
  it('is the agent name under a prefix no generated job id can carry', () => {
    expect(agentNotifyKey('claude')).toBe('agent_claude');
    // `jobSlug` collapses `_` to `-`, so a job named after this key still
    // cannot collide with it: `JobStore` deleting a job never takes a notify.
    expect(jobSlug('agent_claude')).not.toBe(agentNotifyKey('claude'));
    expect(jobSlug('agent_codex')).toBe('agent-codex');
  });
});

describe('notifyRefusal', () => {
  it('names Telegram being off, in all three ways it can be off', () => {
    expect(notifyRefusal(config(false, true, true))).toBe(TELEGRAM_OFF);
    expect(notifyRefusal({ jobs: { enabled: true } as NotifyConfig['jobs'] })).toBe(TELEGRAM_OFF);
    expect(notifyRefusal(config(true, false, true))).toBe(TELEGRAM_OFF);
  });

  it('names jobs being off once Telegram is on', () => {
    expect(notifyRefusal(config(true, true, false))).toBe(JOBS_OFF);
    expect(notifyRefusal({ remote: { enabled: true, telegram: { enabled: true } } as NotifyConfig['remote'] })).toBe(
      JOBS_OFF,
    );
  });

  it('refuses nothing when a window could deliver the message', () => {
    expect(notifyRefusal(ALL_ON)).toBeUndefined();
  });
});

describe('makeNotifyOwner', () => {
  it('writes one coalescing outbox item under the agent key', async () => {
    const dir = tempDir();
    const notify = makeNotifyOwner(() => ALL_ON, dir);
    await expect(notify('codex', 'lane B is done')).resolves.toEqual({ kind: 'queued' });

    const item = JSON.parse(
      fs.readFileSync(path.join(dir, 'agent_codex.json'), 'utf8'),
    ) as OutboxItem;
    expect(item).toMatchObject({
      job_id: 'agent_codex',
      name: 'codex',
      text: 'lane B is done',
      earlier_count: 0,
    });
    expect(typeof item.changed_at).toBe('number');
    expect(item.first_undelivered_at).toBe(item.changed_at);
  });

  it('replaces the pending text and keeps the item age, as the job outbox does', async () => {
    const dir = tempDir();
    const notify = makeNotifyOwner(() => ALL_ON, dir);
    await notify('codex', 'first');
    const first = JSON.parse(
      fs.readFileSync(path.join(dir, 'agent_codex.json'), 'utf8'),
    ) as OutboxItem;
    await notify('codex', 'second');
    const second = JSON.parse(
      fs.readFileSync(path.join(dir, 'agent_codex.json'), 'utf8'),
    ) as OutboxItem;

    expect(second.text).toBe('second');
    expect(second.earlier_count).toBe(1);
    expect(second.first_undelivered_at).toBe(first.first_undelivered_at);
    // Still exactly one file per name: two notifies never become two messages.
    expect(fs.readdirSync(dir)).toEqual(['agent_codex.json']);
  });

  it('refuses and writes nothing when this window could not deliver it', async () => {
    const dir = tempDir();
    const notify = makeNotifyOwner(() => config(false, false, true), dir);
    await expect(notify('claude', 'done')).resolves.toEqual({
      kind: 'refused',
      error: TELEGRAM_OFF,
    });
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('handleAgentNotifyRoute', () => {
  const queuedText = (from: string): string =>
    `Queued for the owner's Telegram. The Forge window holding the Telegram lease sends it; until then a newer notify from ${from} replaces it.`;

  it('answers the queued sentence the agent can repeat to its user', async () => {
    const notifyOwner = async (): Promise<AgentNotifyResult> => ({ kind: 'queued' });
    await expect(handleAgentNotifyRoute('codex', { text: 'done\n' }, notifyOwner)).resolves.toEqual({
      status: 200,
      text: queuedText('codex'),
    });
  });

  it('answers a refusal with the reason, at 409', async () => {
    const notifyOwner = async (): Promise<AgentNotifyResult> => ({
      kind: 'refused',
      error: JOBS_OFF,
    });
    await expect(handleAgentNotifyRoute('codex', { text: 'done' }, notifyOwner)).resolves.toEqual({
      status: 409,
      text: JOBS_OFF,
    });
  });

  it('refuses a notify over the cap, and one that is not text, before writing', async () => {
    const written: string[] = [];
    const notifyOwner = async (from: string, text: string): Promise<AgentNotifyResult> => {
      written.push(`${from}:${text.length}`);
      return { kind: 'queued' };
    };
    const tooLong = await handleAgentNotifyRoute(
      'codex',
      { text: 'x'.repeat(AGENT_NOTIFY_MAX_CHARS + 1) },
      notifyOwner,
    ).catch((error: unknown) => error);
    expect(tooLong).toBeInstanceOf(AgentRouteHttpError);
    expect((tooLong as AgentRouteHttpError).status).toBe(400);

    const missing = await handleAgentNotifyRoute('codex', {}, notifyOwner).catch(
      (error: unknown) => error,
    );
    expect(missing).toBeInstanceOf(AgentRouteHttpError);
    expect((missing as AgentRouteHttpError).status).toBe(400);
    expect(written).toEqual([]);
  });
});
