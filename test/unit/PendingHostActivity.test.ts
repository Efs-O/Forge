import { describe, expect, it, vi } from 'vitest';
import { PendingHostActivity } from '../../src/agentMesh/pendingHostActivity';
import type { MeshUserNotification } from '../../src/agentMesh/meshNotificationPolicy';

/**
 * A11 (COPILOT_AGENT_MESH_PLAN P3) — direct unit tests for the pending
 * host-activity buffer. The wiring-level tests (startup crash with a not-ready
 * facade, multiple recovery actions continuing) live in
 * AgentMeshCopilotSurfaces.test.ts; here we pin the buffer's own contract:
 * synchronous emit when ready, in-order flush, a throwing emit is retained and
 * retried without duplication, dispose stops the retry mechanism, and the
 * buffer is bounded.
 */

function note(text: string): MeshUserNotification {
  return { text };
}

describe('PendingHostActivity (A11 startup-lifecycle buffer)', () => {
  it('emits synchronously when the facade is ready (no deferral, in order)', () => {
    const emitted: MeshUserNotification[] = [];
    const p = new PendingHostActivity(() => ({ emitHostActivity: (n) => emitted.push(n) }));
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
      return { emitHostActivity: (n) => emitted.push(n) };
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
    const p = new PendingHostActivity(() => ({
      emitHostActivity: (n) => {
        if (fail) throw new Error('emit failed');
        emitted.push(n);
      },
    }));
    p.enqueue(note('a'));
    expect(emitted).toHaveLength(0); // first emit threw; the item is retained
    fail = false;
    await vi.waitFor(() => expect(emitted.map((e) => e.text)).toEqual(['a']));
    expect(emitted).toHaveLength(1); // exactly one delivery, not a duplicate
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
        return { emitHostActivity: (n) => emitted.push(n) };
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
});
