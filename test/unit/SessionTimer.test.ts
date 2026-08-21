import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionTimer } from '../../src/sidebar/SessionTimer';
import type { ConversationRuntime, SidebarRuntime } from '../../src/sidebar/sessionTypes';

function conversation(id = 'c1'): ConversationRuntime {
  return { id, title: id, createdAt: 0, updatedAt: 0, messages: [] };
}

function session(conversations: ConversationRuntime[]): SidebarRuntime {
  return { activeConversationId: conversations[0]?.id ?? 'c1', conversations, history: [] };
}

describe('SessionTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('accumulates an active interval and ignores duplicate finishes', () => {
    const timer = new SessionTimer();
    const conv = conversation();

    timer.start(conv);
    vi.advanceTimersByTime(3_250);
    timer.finish(conv);
    timer.finish(conv);

    expect(conv.active_time_ms).toBe(3_250);
    expect(conv.active_started_at).toBeUndefined();
    expect(timer.totalActiveMs(conv)).toBe(3_250);
  });

  it('excludes approval time, including time queued behind another approval', () => {
    const timer = new SessionTimer();
    const conv = conversation();

    timer.start(conv);
    vi.advanceTimersByTime(1_000);
    timer.pauseApproval(conv.id);
    vi.advanceTimersByTime(4_000);
    expect(timer.totalActiveMs(conv)).toBe(1_000);
    timer.resumeApproval(conv.id);
    vi.advanceTimersByTime(2_000);
    timer.finish(conv);

    expect(conv.active_time_ms).toBe(3_000);
  });

  it('counts a persisted unfinished interval through reload', () => {
    const timer = new SessionTimer();
    const conv = conversation();
    conv.active_time_ms = 500;
    conv.active_started_at = 1_000;

    vi.setSystemTime(6_000);
    timer.restoreUnfinishedIntervals(session([conv]));

    expect(conv.active_time_ms).toBe(5_500);
    expect(conv.active_started_at).toBeUndefined();
  });

  it('checkpoints each active conversation and disposes its interval', () => {
    const timer = new SessionTimer();
    const conv = conversation();
    const checkpoints: string[] = [];
    timer.setCheckpointCallback((id) => checkpoints.push(id));
    timer.start(conv);

    vi.advanceTimersByTime(10_000);
    expect(checkpoints).toEqual(['c1']);
    timer.dispose();
    vi.advanceTimersByTime(20_000);
    expect(checkpoints).toEqual(['c1']);
  });

  it('disposes a conversation without leaving active timer state', () => {
    const timer = new SessionTimer();
    const conv = conversation();
    timer.start(conv);
    vi.advanceTimersByTime(2_000);

    timer.disposeConversation(conv);

    expect(conv.active_time_ms).toBe(2_000);
    expect(timer.isActive(conv.id)).toBe(false);
  });
});
