import { beforeEach, describe, expect, it, vi } from 'vitest';

const flush = vi.fn();
const updateTitle = vi.fn();
const logTurnError = vi.fn();
const logTurnStopped = vi.fn();
// The real logger writes a transcript under ~/.forge on every finished turn.
vi.mock('../../src/sidebar/SessionLogger', () => ({
  SessionLogger: vi.fn().mockImplementation(function SessionLoggerMock() {
    return { flush, updateTitle, logTurnError, logTurnStopped };
  }),
}));

import { SendPipeline, type SendPipelineDeps } from '../../src/sidebar/SendPipeline';
import type { ForgeConfig } from '../../src/config/types';
import type { ConversationRuntime, SidebarRuntime } from '../../src/sidebar/sessionTypes';
import type { HostToWebview } from '../../src/sidebar/messageBridge';
import { RequestChainLifecycle } from '../../src/sidebar/RequestChainLifecycle';
import { CONTEXT_EXHAUSTED_MESSAGE } from '../../src/agent/truncationRecovery';

function conversation(overrides: Partial<ConversationRuntime> = {}): ConversationRuntime {
  return {
    id: 'conv-1',
    title: 'Tab',
    messages: [],
    createdAt: 0,
    updatedAt: 0,
    archived: false,
    active_model: null,
    ...overrides,
  } as ConversationRuntime;
}

interface Harness {
  pipeline: SendPipeline;
  posted: HostToWebview[];
  runTurn: ReturnType<typeof vi.fn>;
  deps: SendPipelineDeps;
  conv: ConversationRuntime;
  requestChains: RequestChainLifecycle;
}

function harness(
  options: {
    config?: Partial<ForgeConfig>;
    conv?: Partial<ConversationRuntime>;
    streaming?: boolean;
    cancellationPending?: boolean;
    streamingAfterWait?: boolean;
  } = {},
): Harness {
  const conv = conversation(options.conv);
  const posted: HostToWebview[] = [];
  const runTurn = vi.fn().mockResolvedValue({
    kind: 'completed',
    finalText: 'finished',
    finishReason: 'stop',
  });
  let waited = false;

  const config = {
    active_model: 'qwen',
    models: [{ name: 'qwen' }],
    ...options.config,
  } as ForgeConfig;

  const sidebar = { activeConversationId: conv.id, conversations: [conv] } as SidebarRuntime;
  const requestChains = new RequestChainLifecycle();

  const deps: SendPipelineDeps = {
    getConfig: () => config,
    getSidebar: () => sidebar,
    getActive: () => conv,
    agentLoop: {
      isStreamingConv: () =>
        waited ? (options.streamingAfterWait ?? false) : (options.streaming ?? false),
      isCancellationPending: () => options.cancellationPending ?? false,
      waitForCancelledTurns: async () => {
        waited = true;
      },
      runTurn,
    } as unknown as SendPipelineDeps['agentLoop'],
    requestChains,
    failureTracker: { reset: vi.fn() } as unknown as SendPipelineDeps['failureTracker'],
    events: { onBackendError: vi.fn() },
    post: (msg) => posted.push(msg),
    persistSession: vi.fn(),
    postSessionSync: vi.fn(),
    evaluateAfterTurn: vi.fn(async () => undefined),
    resetContextWarning: vi.fn(),
  };

  return { pipeline: new SendPipeline(deps), posted, runTurn, deps, conv, requestChains };
}

function errors(posted: HostToWebview[]): string[] {
  return posted.filter((m) => m.type === 'error').map((m) => (m as { message: string }).message);
}

describe('SendPipeline.send', () => {
  beforeEach(() => vi.clearAllMocks());

  it('echoes a prompt the webview did not type, before the turn starts', async () => {
    const h = harness();
    await h.pipeline.send('from telegram', undefined, 'conv-1', undefined, {
      echoPrompt: true,
    });

    // Without this the tab goes busy with no user bubble above it: the webview
    // draws its own from USER_SEND, and sessionSync deliberately keeps the
    // local transcript for a conversation that is already streaming.
    const echo = h.posted.findIndex(
      (msg) => msg.type === 'userPrompt' && msg.text === 'from telegram',
    );
    const started = h.posted.findIndex((msg) => msg.type === 'generationStarted');
    expect(echo).toBeGreaterThanOrEqual(0);
    expect(echo).toBeLessThan(started);
  });

  it('does not echo a prompt the webview typed itself', async () => {
    const h = harness();
    await h.pipeline.send('typed here');
    expect(h.posted.some((msg) => msg.type === 'userPrompt')).toBe(false);
  });

  it('does not echo a prompt that failed admission', async () => {
    const h = harness({ streaming: true });
    await h.pipeline.send('from telegram', undefined, 'conv-1', undefined, {
      echoPrompt: true,
    });
    // A refused prompt never ran, so a bubble for it would be a lie.
    expect(h.posted.some((msg) => msg.type === 'userPrompt')).toBe(false);
  });

  it('runs the turn on the active conversation', async () => {
    const h = harness();
    const outcome = await h.pipeline.send('hello');

    expect(h.runTurn).toHaveBeenCalledOnce();
    const [conv, model, text] = h.runTurn.mock.calls[0]!;
    expect(conv.id).toBe('conv-1');
    expect(model.name).toBe('qwen');
    expect(text).toBe('hello');
    expect(errors(h.posted)).toEqual([]);
    expect(outcome).toEqual({ kind: 'completed', finalText: 'finished' });
  });

  it('announces an accepted host-initiated turn so Stop is available', async () => {
    const h = harness();
    await h.pipeline.send('continue after compaction', undefined, 'conv-1');

    expect(h.posted).toContainEqual({
      type: 'generationStarted',
      conversationId: 'conv-1',
    });
  });

  it('refuses a conversation that no longer exists', async () => {
    const h = harness();
    await h.pipeline.send('hello', undefined, 'conv-gone');

    expect(h.runTurn).not.toHaveBeenCalled();
    expect(errors(h.posted)).toEqual(['Forge: the queued conversation is no longer open.']);
  });

  it('refuses to overlap a turn that is still streaming', async () => {
    const h = harness({ streaming: true });
    await h.pipeline.send('hello');

    expect(h.runTurn).not.toHaveBeenCalled();
    expect(errors(h.posted)[0]).toContain('still generating');
  });

  it('waits for a cancelling turn, then proceeds', async () => {
    // Cancellation pending: the first guard lets it through, and by the time
    // waitForCancelledTurns resolves the conversation is no longer streaming.
    const h = harness({ streaming: true, cancellationPending: true, streamingAfterWait: false });
    await h.pipeline.send('hello');

    expect(h.runTurn).toHaveBeenCalledOnce();
    expect(errors(h.posted)).toEqual([]);
  });

  it('refuses if the turn is still streaming after the wait', async () => {
    const h = harness({ streaming: true, cancellationPending: true, streamingAfterWait: true });
    await h.pipeline.send('hello');

    expect(h.runTurn).not.toHaveBeenCalled();
    expect(errors(h.posted)[0]).toContain('Cancel it before sending again');
  });

  it('surfaces "no model selected" to the status bar as well as the transcript', async () => {
    const h = harness({ config: { active_model: undefined } as Partial<ForgeConfig> });
    await h.pipeline.send('hello');

    expect(h.runTurn).not.toHaveBeenCalled();
    expect(errors(h.posted)[0]).toContain('no active model selected');
    expect(h.deps.events.onBackendError).toHaveBeenCalledOnce();
  });

  it('reports an unresolvable model instead of throwing', async () => {
    const h = harness({ config: { active_model: 'ghost', models: [] } as Partial<ForgeConfig> });
    await h.pipeline.send('hello');

    expect(h.runTurn).not.toHaveBeenCalled();
    expect(errors(h.posted)).toHaveLength(1);
  });

  it('does not advance the accepted-intent epoch for rejected preflight', async () => {
    const missing = harness({ config: { active_model: undefined } as Partial<ForgeConfig> });
    await missing.pipeline.send('hello');
    expect(missing.requestChains.currentEpoch('conv-1')).toBe(0);

    const invalid = harness({
      config: { active_model: 'ghost', models: [] } as Partial<ForgeConfig>,
    });
    await invalid.pipeline.send('hello');
    expect(invalid.requestChains.currentEpoch('conv-1')).toBe(0);
  });

  it('rejects incompatible image input before admission', async () => {
    const h = harness();
    await h.pipeline.send('look', [
      { name: 'image.png', mediaType: 'image/png', data: 'aGVsbG8=' },
    ]);
    expect(h.runTurn).not.toHaveBeenCalled();
    expect(h.requestChains.currentEpoch('conv-1')).toBe(0);
    expect(errors(h.posted)[0]).toContain('not configured for image input');
  });

  it('holds one admission until the accepted turn settles', async () => {
    let finish!: () => void;
    const pending = new Promise<{
      kind: 'completed';
      finalText: string;
      finishReason: string;
    }>((resolve) => {
      finish = () => resolve({ kind: 'completed', finalText: 'first done', finishReason: 'stop' });
    });
    const h = harness();
    h.runTurn.mockReturnValueOnce(pending);
    const first = h.pipeline.send('first');
    await vi.waitFor(() => expect(h.runTurn).toHaveBeenCalledOnce());
    await h.pipeline.send('second');
    expect(h.runTurn).toHaveBeenCalledOnce();
    expect(h.requestChains.currentEpoch('conv-1')).toBe(1);
    finish();
    await first;
    expect(h.requestChains.isReserved('conv-1')).toBe(false);
  });

  it('runs an internal continuation under the same reservation and intent epoch', async () => {
    const h = harness();
    vi.mocked(h.deps.evaluateAfterTurn)
      .mockResolvedValueOnce({ kind: 'continue', text: 'resume', options: { internal: true } })
      .mockResolvedValueOnce(undefined);
    h.runTurn
      .mockResolvedValueOnce({ kind: 'completed', finalText: 'partial', finishReason: 'length' })
      .mockResolvedValueOnce({ kind: 'completed', finalText: 'final', finishReason: 'stop' });

    const outcome = await h.pipeline.send('start');

    expect(h.runTurn).toHaveBeenCalledTimes(2);
    expect(h.runTurn.mock.calls[1]?.[2]).toBe('resume');
    expect(h.runTurn.mock.calls[1]?.[4]).toEqual({ internal: true });
    expect(h.requestChains.currentEpoch('conv-1')).toBe(1);
    expect(outcome).toEqual({ kind: 'completed', finalText: 'final' });
  });

  it('auto-compacts and resumes a recoverable context-exhaustion failure', async () => {
    const h = harness();
    vi.mocked(h.deps.evaluateAfterTurn)
      .mockResolvedValueOnce({ kind: 'continue', text: 'resume', options: { internal: true } })
      .mockResolvedValueOnce(undefined);
    h.runTurn
      .mockResolvedValueOnce({ kind: 'failed', error: CONTEXT_EXHAUSTED_MESSAGE, finalText: '' })
      .mockResolvedValueOnce({ kind: 'completed', finalText: 'recovered', finishReason: 'stop' });

    const outcome = await h.pipeline.send('start remotely');

    expect(h.deps.evaluateAfterTurn).toHaveBeenCalledTimes(2);
    expect(h.runTurn.mock.calls[1]?.[2]).toBe('resume');
    expect(outcome).toEqual({ kind: 'completed', finalText: 'recovered' });
    // The failed attempt is on record even though the retry succeeded: a turn
    // that fails writes no messages of its own, so without this row the log
    // ends on the last good tool call and reads as a healthy turn.
    expect(logTurnError).toHaveBeenCalledWith(CONTEXT_EXHAUSTED_MESSAGE, expect.any(String));
  });

  it('records a cancelled turn, so its log does not end on the bare prompt', async () => {
    const h = harness();
    h.runTurn.mockResolvedValueOnce({ kind: 'cancelled', finalText: '' });

    const outcome = await h.pipeline.send('ping');

    expect(outcome).toEqual({ kind: 'cancelled' });
    expect(logTurnStopped).toHaveBeenCalledWith('cancelled', expect.any(String));
  });

  it('writes no error row for a turn that succeeded', async () => {
    const h = harness();
    h.runTurn.mockResolvedValueOnce({
      kind: 'completed',
      finalText: 'done',
      finishReason: 'stop',
    });

    await h.pipeline.send('start');

    expect(logTurnError).not.toHaveBeenCalled();
  });

  it('pins the full selection including @profile on the conversation', async () => {
    const h = harness({
      config: {
        active_model: 'qwen@fast',
        models: [{ name: 'qwen' }],
        profiles: { fast: { sampling: { temperature: 0.1 } } },
      } as Partial<ForgeConfig>,
    });
    await h.pipeline.send('hello');

    // Not the base name: a tab switch has to restore the profile too (F6).
    expect(h.conv.active_model).toBe('qwen@fast');
  });

  it('still refreshes and persists when the turn throws', async () => {
    const h = harness();
    h.runTurn.mockRejectedValue(new Error('backend died'));

    await expect(h.pipeline.send('hello')).rejects.toThrow('backend died');
    expect(h.deps.persistSession).toHaveBeenCalledOnce();
    expect(h.deps.postSessionSync).toHaveBeenCalledOnce();
    expect(h.deps.failureTracker.reset).toHaveBeenCalledOnce();
    expect(h.deps.evaluateAfterTurn).not.toHaveBeenCalled();
  });

  it('only writes a session log for a conversation that has messages', async () => {
    const h = harness();
    await h.pipeline.send('hello');
    expect(flush).not.toHaveBeenCalled();

    h.conv.messages.push({ role: 'user', content: 'hello' });
    await h.pipeline.send('again');
    expect(flush).toHaveBeenCalledOnce();
  });
});

describe('SendPipeline.submitExternal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws rather than posting, because the caller is code', async () => {
    const h = harness({ streaming: true });

    await expect(h.pipeline.submitExternal('hello')).rejects.toThrow('still generating');
    expect(errors(h.posted)).toEqual([]);
    expect(h.runTurn).not.toHaveBeenCalled();
  });

  it('throws if still streaming after the wait', async () => {
    const h = harness({ streaming: true, cancellationPending: true, streamingAfterWait: true });

    await expect(h.pipeline.submitExternal('hello')).rejects.toThrow(
      'Cancel it before sending again',
    );
  });

  it('reveals the sidebar and sends', async () => {
    const h = harness();
    await h.pipeline.submitExternal('hello');

    expect(h.runTurn).toHaveBeenCalledOnce();
  });
});

describe('SendPipeline guard errors address their own conversation', () => {
  // The webview resolves an unaddressed message against the ACTIVE tab, and its
  // ERROR action clears that tab's streaming state. An unaddressed refusal for a
  // background conversation therefore hid the Stop button on the tab the user
  // was looking at, while the real conversation kept streaming uncancellable.
  it('names the conversation when refusing a send that is still generating', async () => {
    const { pipeline, posted } = harness({ streaming: true });
    await pipeline.send('hello', undefined, 'conv-1');
    const errors = posted.filter((m) => m.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ conversationId: 'conv-1' });
  });

  it('names the conversation when no model is selected', async () => {
    const { pipeline, posted } = harness({ config: { active_model: undefined } });
    await pipeline.send('hello', undefined, 'conv-1');
    const errors = posted.filter((m) => m.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ conversationId: 'conv-1' });
  });
});
