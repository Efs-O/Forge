import { describe, expect, it } from 'vitest';
import { AgentInbox, INBOX_CAP, type InboxHost } from '../../src/agentBus/agentInbox';

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

function host(overrides: Partial<InboxHost> = {}): InboxHost & {
  submitted: string[];
  warnings: string[];
  busy: boolean;
  finish: () => void;
} {
  const state = {
    submitted: [] as string[],
    warnings: [] as string[],
    busy: false,
    release: [] as (() => void)[],
  };
  return {
    get submitted() {
      return state.submitted;
    },
    get warnings() {
      return state.warnings;
    },
    get busy() {
      return state.busy;
    },
    set busy(v: boolean) {
      state.busy = v;
    },
    finish: () => state.release.shift()?.(),
    isBusy: () => state.busy,
    submit: (prompt) => {
      state.submitted.push(prompt);
      return new Promise<void>((r) => state.release.push(r));
    },
    warn: (m) => state.warnings.push(m),
    ...overrides,
  };
}

describe('AgentInbox', () => {
  it('submits at once when idle, and one turn at a time', async () => {
    const h = host();
    const inbox = new AgentInbox(h, 5);
    inbox.accept('one');
    inbox.accept('two');
    await tick();
    expect(h.submitted).toEqual(['one']);
    h.finish();
    await tick();
    expect(h.submitted).toEqual(['one', 'two']);
    inbox.dispose();
  });

  it('waits while the chat is busy', async () => {
    const h = host();
    h.busy = true;
    const inbox = new AgentInbox(h, 5);
    inbox.accept('later');
    await tick();
    expect(h.submitted).toEqual([]);
    h.busy = false;
    await tick();
    expect(h.submitted).toEqual(['later']);
    inbox.dispose();
  });

  it('treats a chat that is not up yet as busy', async () => {
    let ready = false;
    const h = host({
      isBusy: () => {
        if (!ready) throw new ReferenceError('sidebarProvider is not initialized');
        return false;
      },
    });
    const inbox = new AgentInbox(h, 5);
    inbox.accept('early');
    await tick();
    expect(h.submitted).toEqual([]);
    ready = true;
    await tick();
    expect(h.submitted).toEqual(['early']);
    inbox.dispose();
  });

  it('caps the queue', () => {
    const h = host();
    h.busy = true;
    const inbox = new AgentInbox(h, 1_000);
    for (let i = 0; i < INBOX_CAP; i++) expect(inbox.accept(`m${i}`)).toBe(i + 1);
    expect(inbox.accept('overflow')).toBeUndefined();
    inbox.dispose();
    expect(inbox.pending).toBe(0);
  });

  it('warns the user when a submit fails, then moves on', async () => {
    const h = host({ submit: () => Promise.reject(new Error('no model')) });
    const inbox = new AgentInbox(h, 5);
    inbox.accept('a');
    inbox.accept('b');
    await tick();
    expect(h.warnings).toHaveLength(2);
    expect(h.warnings[0]).toContain('no model');
    inbox.dispose();
  });
});
