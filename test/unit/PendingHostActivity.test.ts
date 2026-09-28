import { describe, expect, it, vi } from 'vitest';
import { PendingHostActivity } from '../../src/agentMesh/pendingHostActivity';
import type { MeshUserNotification } from '../../src/agentMesh/meshNotificationPolicy';

/**
 * A11 (COPILOT_AGENT_MESH_PLAN P3) — direct unit tests for the pending
 * host-activity buffer. The wiring-level tests (startup crash with a not-ready
 * facade, multiple recovery actions continuing, and the production-order
 * facade-before-sink sequence) live in AgentMeshCopilotSurfaces.test.ts; here
 * we pin the buffer's own contract: synchronous emit when ready, in-order
 * flush, a throwing emit is retained and retried without duplication, dispose
 * stops the retry mechanism, the buffer is bounded, and readiness is the
 * facade's host-activity listener count (a facade with count 0 is not ready).
 */

function note(text: string): MeshUserNotification {
  return { text };
}

describe('PendingHostActivity (A11 startup-lifecycle buffer)', () => {
  it('emits synchronously when the facade is ready (no deferral, in order)', () => {
    const emitted: MeshUserNotification[] = [];
    const p = new PendingHostActivity(
      () => ({
        emitHostActivity: (n) => emitted.push(n),
        hostActivityListenerCount: () => 1,
      }),
    );
    p.enqueue(note('a'));
    p.enqueue(note('b'));
    expect(emitted.map((e) => e.text)).toEqual(['a', 'b']);
    p.dispose();
  });

  it('buffers when the facade is not ready, then flushes in order once it is', async () => {
    let ready = false;
    const emitted: MeshUserNotification[] = [];
    const p = new PendingHostActivity(() => {
      if (!ready) throw new Error('not ready');
      return { emitHostActivity: (n) => emitted.push(n), hostActivityListenerCount: () => 1 };
    });
    p.enqueue(note('a'));
    p.enqueue(note('b'));
    expect(emitted).toHaveLength(0); // buffered, not emitted, not lost
    ready = true;
    await vi.waitFor(() => expect(emitted.map((e) => e.text)).toEqual(['a', 'b']));
    p.dispose();
  });

  it('retries a throwing emit without dropping or duplicating the item', async () => {
    const emitted: MeshUserNotification[] = [];
    let fail = true;
    const p = new PendingHostActivity(
      () => ({
        emitHostActivity: (n) => {
          if (fail) throw new Error('emit failed');
          emitted.push(n);
        },
        hostActivityListenerCount: () => 1,
      }),
    );
    p.enqueue(note('a'));
    expect(emitted).toHaveLength(0); // first emit threw; the item is retained
    fail = false;
    await vi.waitFor(() => expect(emitted.map((e) => e.text)).toEqual(['a']));
    expect(emitted).toHaveLength(1); // exactly one delivery, not a duplicate
    p.dispose();
  });

  it('retries when the listener-count readiness probe throws', async () => {
    const emitted: MeshUserNotification[] = [];
    let fail = true;
    const p = new PendingHostActivity(() => ({
      emitHostActivity: (n) => emitted.push(n),
      hostActivityListenerCount: () => {
        if (fail) throw new Error('readiness unavailable');
        return 1;
      },
    }));
    p.enqueue(note('a'));
    expect(emitted).toHaveLength(0);
    fail = false;
    await vi.waitFor(() => expect(emitted.map((e) => e.text)).toEqual(['a']));
    p.dispose();
  });

  it('dispose clears the buffer and stops the retry mechanism (no later delivery)', async () => {
    const emitted: MeshUserNotification[] = [];
    const p = new PendingHostActivity(() => {
      throw new Error('never ready');
    });
    p.enqueue(note('a'));
    p.dispose();
    // The retry timer was cleared, so no further drain runs even if the facade
    // were to become ready later.
    await new Promise((r) => setTimeout(r, 300));
    expect(emitted).toHaveLength(0);
  });

  it('bounds the buffer: when the cap is exceeded the oldest item is dropped', async () => {
    let ready = false;
    const emitted: MeshUserNotification[] = [];
    const p = new PendingHostActivity(
      () => {
        if (!ready) throw new Error('not ready');
        return { emitHostActivity: (n) => emitted.push(n), hostActivityListenerCount: () => 1 };
      },
      2, // maxPending = 2
    );
    p.enqueue(note('a'));
    p.enqueue(note('b'));
    p.enqueue(note('c')); // cap=2: 'a' dropped, 'b' and 'c' retained
    ready = true;
    await vi.waitFor(() => expect(emitted).toHaveLength(2));
    expect(emitted.map((e) => e.text)).toEqual(['b', 'c']);
    p.dispose();
  });

  it('facade available but sink not ready (listener count 0): the item is buffered, not dropped; a listener flushes exactly one', async () => {
    // The facade exists from the start (the sidebar is up), but no transport
    // has subscribed its onHostActivity listener, so the listener count is 0.
    // A naive "facade-exists = ready" flush would deliver into an empty
    // listener set and lose the item; the buffer must hold it until a listener
    // is present.
    let listeners = 0;
    const emitted: MeshUserNotification[] = [];
    const p = new PendingHostActivity(
      () => ({
        emitHostActivity: (n) => emitted.push(n),
        hostActivityListenerCount: () => listeners,
      }),
    );
    p.enqueue(note('a'));
    // The facade is available, but the sink is not ready (count 0): the item
    // is buffered, not emitted into the void, not dropped.
    expect(emitted).toHaveLength(0);
    // The retry timer fires (250ms) but must NOT flush while the count is 0 —
    // this is the exact race a facade-exists-only readiness would lose.
    await new Promise((r) => setTimeout(r, 300));
    expect(emitted).toHaveLength(0);
    // A transport subscribes (count 1); the buffered item flushes exactly once.
    listeners = 1;
    await vi.waitFor(() => expect(emitted.map((e) => e.text)).toEqual(['a']));
    expect(emitted).toHaveLength(1);
    p.dispose();
  });
});
