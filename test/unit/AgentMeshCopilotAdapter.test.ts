import { describe, expect, it } from 'vitest';
import { CopilotOwnedAdapter } from '../../src/agentMesh/adapters';
import type { CliAgentRunResult } from '../../src/agents/types';

/** A controllable fake owned Copilot ACP session (no real process). */
class FakeCopilotSession {
  interrupted = false;
  received: string[] = [];
  confirmed: string | undefined;
  private next: CliAgentRunResult;
  constructor(confirmed: string | undefined, next: CliAgentRunResult) {
    this.confirmed = confirmed;
    this.next = next;
  }
  get confirmedSessionId(): string | undefined {
    return this.confirmed;
  }
  get pid(): number | undefined {
    return 4242;
  }
  async send(task: string): Promise<CliAgentRunResult> {
    this.received.push(task);
    return this.next;
  }
  interrupt(): void {
    this.interrupted = true;
  }
  async dispose(): Promise<void> {}
}

describe('CopilotOwnedAdapter (P2)', () => {
  it('is an observing copilot adapter', () => {
    const session = new FakeCopilotSession('id', { status: 'completed', finalText: 'x' });
    const adapter = new CopilotOwnedAdapter(session);
    expect(adapter.kind).toBe('copilot');
    expect(adapter.observesTurns).toBe(true);
    expect(adapter.key).toBe('copilot-owned');
  });

  it('send resolves at turn end with the final text', async () => {
    const session = new FakeCopilotSession('id', { status: 'completed', finalText: 'the answer' });
    const adapter = new CopilotOwnedAdapter(session);
    const result = await adapter.send('question');
    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('the answer');
    expect(session.received).toEqual(['question']);
  });

  it('maps a timed-out turn to failed (no timed_out state reaches the board)', async () => {
    const session = new FakeCopilotSession('id', { status: 'timed_out', finalText: '' });
    const adapter = new CopilotOwnedAdapter(session);
    const result = await adapter.send('question');
    expect(result.status).toBe('failed');
  });

  it('fires onTurnEnd after the turn (so the confirmed id is recorded)', async () => {
    const session = new FakeCopilotSession('id', { status: 'completed', finalText: 'x' });
    let turns = 0;
    const adapter = new CopilotOwnedAdapter(session, () => {
      turns++;
    });
    await adapter.send('question');
    expect(turns).toBe(1);
  });

  it('interrupt() interrupts the running session turn', async () => {
    const session = new FakeCopilotSession('id', { status: 'cancelled', finalText: '' });
    const adapter = new CopilotOwnedAdapter(session);
    adapter.interrupt();
    expect(session.interrupted).toBe(true);
  });

  it('prepends the creation preamble when takePreamble returns one', async () => {
    const session = new FakeCopilotSession('id', { status: 'completed', finalText: 'x' });
    let preamble = 'PRE:';
    const adapter = new CopilotOwnedAdapter(session, undefined, () => {
      const p = preamble;
      preamble = undefined; // consumed once
      return p;
    });
    await adapter.send('hello');
    expect(session.received).toEqual(['PRE:hello']);
    // Second turn: no preamble.
    await adapter.send('again');
    expect(session.received).toEqual(['PRE:hello', 'again']);
  });

  it('sends the bare message when takePreamble is absent (resume)', async () => {
    const session = new FakeCopilotSession('id', { status: 'completed', finalText: 'x' });
    const adapter = new CopilotOwnedAdapter(session, undefined, () => undefined);
    await adapter.send('hello');
    expect(session.received).toEqual(['hello']);
  });
});
