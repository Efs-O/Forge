import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationRuntime, SidebarRuntime } from '../../src/sidebar/sessionTypes';
import type { HostToWebview } from '../../src/sidebar/messageBridge';

type ConfigListener = (event: { affectsConfiguration(section: string): boolean }) => void;
type SettledListener = (id: string, outcome: unknown) => void | Promise<void>;

const hooks = vi.hoisted(() => ({
  config: undefined as ConfigListener | undefined,
  settled: undefined as SettledListener | undefined,
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({ get: () => 30 }),
    onDidChangeConfiguration: (listener: ConfigListener) => {
      hooks.config = listener;
      return { dispose: vi.fn() };
    },
  },
}));

vi.mock('../../src/sidebar/workerChatWake', () => ({
  subscribeConversationSettled: (listener: SettledListener) => {
    hooks.settled = listener;
    return {
      dispose: () => {
        if (hooks.settled === listener) hooks.settled = undefined;
      },
    };
  },
}));

const { ConversationRetentionScheduler, isConversationExpired } = await import(
  '../../src/sidebar/ConversationRetentionScheduler'
);
const GRACE_MS = 60_000;

interface TimerRecord {
  id: number;
  due: number;
  callback: () => void;
}

class FakeClock {
  time = 1_000;
  private nextId = 0;
  private readonly timers = new Map<number, TimerRecord>();

  schedule = (callback: () => void, delay: number): ReturnType<typeof setTimeout> => {
    const id = ++this.nextId;
    this.timers.set(id, { id, due: this.time + delay, callback });
    return { id } as unknown as ReturnType<typeof setTimeout>;
  };

  cancel = (timer: ReturnType<typeof setTimeout>): void => {
    this.timers.delete((timer as unknown as { id: number }).id);
  };

  async advanceBy(amount: number): Promise<void> {
    const target = this.time + amount;
    while (true) {
      const next = [...this.timers.values()]
        .filter((timer) => timer.due <= target)
        .sort((a, b) => a.due - b.due)[0];
      if (!next) break;
      this.time = next.due;
      this.timers.delete(next.id);
      next.callback();
      await flushMicrotasks();
    }
    this.time = target;
    await flushMicrotasks();
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

function chat(id: string, activityAt = 1_000, keepOpen = false): ConversationRuntime {
  return {
    id,
    title: id,
    createdAt: 1_000,
    updatedAt: 1_000,
    retention_activity_at: activityAt,
    keep_open: keepOpen,
    messages: [],
  };
}

function harness(options: {
  conversations?: ConversationRuntime[];
  now?: number;
  minutes?: unknown;
  blockers?: Map<string, 'clear' | 'blocked' | 'unknown'>;
  persistSidebar?: (next: SidebarRuntime) => Promise<boolean>;
  onInvalidSetting?: (message: string) => void;
} = {}) {
  const clock = new FakeClock();
  clock.time = options.now ?? 1_000;
  let minutes = options.minutes ?? 1;
  let state: SidebarRuntime = {
    activeConversationId: 'active',
    conversations: options.conversations ?? [chat('active'), chat('background')],
    history: [],
  };
  const blockers = options.blockers ?? new Map();
  const archived: string[] = [];
  const posted: HostToWebview[] = [];
  const setSidebar = vi.fn((next: SidebarRuntime) => {
    state = next;
  });
  const persistSession = vi.fn(async () => true);
  const persistSidebar = vi.fn(async (next: SidebarRuntime) => {
    if (options.persistSidebar) return options.persistSidebar(next);
    return true;
  });
  const archiveExpired = vi.fn((id: string, expectedAt: number) => {
    const current = state.conversations.find((conversation) => conversation.id === id);
    if (!current || current.retention_activity_at !== expectedAt || id === state.activeConversationId) return false;
    archived.push(id);
    state = {
      ...state,
      conversations: state.conversations.filter((conversation) => conversation.id !== id),
    };
    return true;
  });
  const scheduler = new ConversationRetentionScheduler({
    getSidebar: () => state,
    setSidebar,
    persistSession,
    persistSidebar,
    post: (message) => posted.push(message),
    blockState: (id) => blockers.get(id) ?? 'clear',
    archiveExpired,
    getSetting: () => minutes,
    now: () => clock.time,
    scheduleTimeout: clock.schedule,
    cancelTimeout: clock.cancel,
    onInvalidSetting: options.onInvalidSetting,
  });
  return {
    scheduler,
    clock,
    archived,
    archiveExpired,
    blockers,
    posted,
    setSidebar,
    persistSession,
    persistSidebar,
    getState: () => state,
    setMinutes: (value: unknown) => {
      minutes = value;
    },
    configure: () => hooks.config?.({ affectsConfiguration: () => true }),
  };
}

describe('conversation inactivity policy', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    hooks.config = undefined;
    hooks.settled = undefined;
    h = harness();
  });

  afterEach(() => {
    h.scheduler.dispose();
  });

  it('expires exactly at the configured boundary, never the selected chat', async () => {
    h.scheduler.start();
    await h.clock.advanceBy(GRACE_MS - 1);
    expect(h.archived).toEqual([]);
    await h.clock.advanceBy(1);
    expect(h.archived).toEqual(['background']);
    expect(h.getState().conversations.map((conversation) => conversation.id)).toEqual(['active']);
  });

  it('updates retention activity without replacing a live conversation runtime', () => {
    const liveRuntime = h.getState().conversations.find((conversation) => conversation.id === 'background');
    expect(liveRuntime).toBeDefined();

    h.clock.time += GRACE_MS;
    expect(h.archived).toEqual([]);
    h.scheduler.start();
    h.clock.time += 10;
    h.scheduler.markActivity('background');

    expect(h.getState().conversations.find((conversation) => conversation.id === 'background')).toBe(liveRuntime);
    liveRuntime?.messages.push({ role: 'assistant', content: 'streamed after the activity update' });
    expect(liveRuntime?.retention_activity_at).toBe(h.clock.time);
    expect(h.getState().conversations.find((conversation) => conversation.id === 'background')?.messages)
      .toHaveLength(1);
  });

  it('starts retention only after remote runtime setup has resolved', () => {
    const extensionSource = readFileSync(path.resolve(process.cwd(), 'src/extension.ts'), 'utf8');
    const remoteSetup = extensionSource.indexOf('const remoteRuntime = await setupRemoteRuntime');
    const retentionStart = extensionSource.indexOf('sidebarProvider.startConversationRetention();');

    expect(remoteSetup).toBeGreaterThanOrEqual(0);
    expect(retentionStart).toBeGreaterThan(remoteSetup);
  });

  it('revalidates a blocker at the deadline and starts a fresh grace period when it clears', async () => {
    h.blockers.set('background', 'blocked');
    h.scheduler.start();
    await h.clock.advanceBy(GRACE_MS);
    expect(h.archived).toEqual([]);
    h.blockers.set('background', 'clear');
    h.scheduler.refresh();
    expect(h.getState().conversations.find((conversation) => conversation.id === 'background')?.retention_activity_at)
      .toBe(h.clock.time);
    await h.clock.advanceBy(GRACE_MS - 1);
    expect(h.archived).toEqual([]);
    await h.clock.advanceBy(1);
    expect(h.archived).toEqual(['background']);
  });

  it('holds expired chats while draft or queue hydration is unknown, then rechecks live state', async () => {
    h.blockers.set('background', 'unknown');
    h.scheduler.start();
    await h.clock.advanceBy(GRACE_MS * 2);
    expect(h.archived).toEqual([]);
    h.blockers.set('background', 'clear');
    h.scheduler.refresh();
    await h.clock.advanceBy(0);
    expect(h.archived).toEqual(['background']);
  });

  it('clears deadlines while disabled and grants a new grace period when reenabled', async () => {
    h.scheduler.start();
    h.setMinutes(0);
    h.configure();
    await h.clock.advanceBy(GRACE_MS * 10);
    expect(h.archived).toEqual([]);
    expect(h.scheduler.isEnabled()).toBe(false);

    h.setMinutes(1);
    h.configure();
    expect(h.getState().conversations.every((conversation) => conversation.retention_activity_at === h.clock.time))
      .toBe(true);
    await h.clock.advanceBy(GRACE_MS - 1);
    expect(h.archived).toEqual([]);
    await h.clock.advanceBy(1);
    expect(h.archived).toEqual(['background']);
  });

  it('surfaces invalid settings and schedules no archive', async () => {
    const onInvalid = vi.fn();
    h.scheduler.dispose();
    h = harness({ minutes: 1, onInvalidSetting: onInvalid });
    h.scheduler.start();
    h.setMinutes(1.5);
    h.configure();
    await h.clock.advanceBy(GRACE_MS * 2);
    expect(onInvalid).toHaveBeenCalledWith(expect.stringContaining('0 to 1440'));
    expect(h.archived).toEqual([]);
  });

  it('pins only after persistence succeeds and gives unpin a new grace period', async () => {
    h.scheduler.start();
    const liveRuntime = h.getState().conversations.find((conversation) => conversation.id === 'background');
    expect(await h.scheduler.setKeepOpen('background', true)).toBe(true);
    expect(h.getState().conversations.find((conversation) => conversation.id === 'background')).toBe(liveRuntime);
    expect(liveRuntime?.keep_open).toBe(true);
    await h.clock.advanceBy(GRACE_MS * 2);
    expect(h.archived).toEqual([]);
    expect(await h.scheduler.setKeepOpen('background', false)).toBe(true);
    expect(h.getState().conversations.find((conversation) => conversation.id === 'background')?.retention_activity_at)
      .toBe(h.clock.time);
    await h.clock.advanceBy(GRACE_MS);
    expect(h.archived).toEqual(['background']);
  });

  it('holds an expired chat open while a pin save is pending', async () => {
    let finishSave: ((saved: boolean) => void) | undefined;
    h = harness({
      persistSidebar: () => new Promise<boolean>((resolve) => { finishSave = resolve; }),
    });
    h.scheduler.start();
    h.clock.time += 1;

    const pin = h.scheduler.setKeepOpen('background', true);
    expect(h.getState().conversations.find((conversation) => conversation.id === 'background')?.retention_activity_at)
      .toBe(h.clock.time);
    await h.clock.advanceBy(GRACE_MS - 1);
    expect(h.archived).toEqual([]);

    finishSave?.(true);
    await expect(pin).resolves.toBe(true);
    expect(h.getState().conversations.find((conversation) => conversation.id === 'background')?.keep_open).toBe(true);
  });

  it('leaves pin state unchanged and reports a persistence failure', async () => {
    h = harness({ persistSidebar: async () => false });
    h.scheduler.start();
    expect(await h.scheduler.setKeepOpen('background', true)).toBe(false);
    expect(h.getState().conversations.find((conversation) => conversation.id === 'background')?.keep_open).toBe(false);
    expect(h.posted).toEqual([
      expect.objectContaining({ type: 'error', message: expect.stringContaining('Could not confirm saving') }),
    ]);
  });

  it('starts settled conversations with a fresh follow-up period', async () => {
    h.scheduler.start();
    await h.clock.advanceBy(GRACE_MS - 1);
    await hooks.settled?.('background', { kind: 'completed' });
    expect(h.getState().conversations.find((conversation) => conversation.id === 'background')?.retention_activity_at)
      .toBe(h.clock.time);
    await h.clock.advanceBy(GRACE_MS - 1);
    expect(h.archived).toEqual([]);
    await h.clock.advanceBy(1);
    expect(h.archived).toEqual(['background']);
  });

  it('migrates missing and future timestamps once, without rewriting a valid timestamp', () => {
    h = harness({
      now: 10_000,
      conversations: [
        { ...chat('active'), retention_activity_at: undefined },
        chat('valid', 2_000),
        chat('future', 20_000),
      ],
    });
    h.scheduler.start();
    expect(h.getState().conversations.map((conversation) => conversation.retention_activity_at)).toEqual([
      10_000,
      2_000,
      10_000,
    ]);
    expect(h.persistSession).toHaveBeenCalledTimes(1);
  });

  it('does not keep a deleted chat alive through a stale timer closure', async () => {
    h.scheduler.start();
    h.setSidebar({ ...h.getState(), conversations: [h.getState().conversations[0]!] });
    h.scheduler.refresh();
    await h.clock.advanceBy(GRACE_MS * 2);
    expect(h.archiveExpired).not.toHaveBeenCalled();
  });

  it('backs off after a failed archive write instead of hot-looping an expired deadline', async () => {
    h.scheduler.start();
    h.archiveExpired.mockImplementation(() => false);
    await h.clock.advanceBy(GRACE_MS);
    expect(h.archiveExpired).toHaveBeenCalledTimes(1);
    await h.clock.advanceBy(GRACE_MS - 1);
    expect(h.archiveExpired).toHaveBeenCalledTimes(1);
    await h.clock.advanceBy(1);
    expect(h.archiveExpired).toHaveBeenCalledTimes(2);
  });

  it('treats invalid future activity as current rather than immediately expired', () => {
    expect(isConversationExpired(chat('future', 20_000), 1, 10_000)).toBe(false);
  });
});
