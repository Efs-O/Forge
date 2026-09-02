import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteAgentProgress } from '../../src/remote/RemoteAgentProgress';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { wireTurnMirror } from '../../src/sidebar/turnMirrorWiring';
import type { HostActivityEvent } from '../../src/sidebar/HostActivity';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';
import type { SidebarProviderEvents } from '../../src/sidebar/AgentLoop';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const directory of tempDirs.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function store(): Promise<RemoteRequestStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-activity-test-'));
  tempDirs.push(directory);
  const result = new RemoteRequestStore(path.join(directory, 'state.json'));
  await result.load();
  return result;
}

function conversation(messages: ConversationRuntime['messages']): ConversationRuntime {
  return { id: 'conv-1', title: 'T', createdAt: 0, updatedAt: 0, messages };
}

describe('window-scoped fan-out', () => {
  // The conversation-keyed sibling cannot carry "models unloaded": a chat bound
  // to a different conversation in the same window is equally affected, and
  // used to hear nothing.
  it('reaches every chat in the workspace, once each, regardless of conversation', async () => {
    const state = await store();
    await state.setBinding({
      channel: 'telegram',
      chatId: 'chat-a',
      workspaceId: 'ws',
      conversationId: 'conv-1',
    });
    await state.setBinding({
      channel: 'telegram',
      chatId: 'chat-b',
      workspaceId: 'ws',
      conversationId: 'conv-2',
    });
    await state.setBinding({
      channel: 'telegram',
      chatId: 'chat-elsewhere',
      workspaceId: 'other-ws',
      conversationId: 'conv-3',
    });

    const here = state.bindingsForWorkspace('ws', 'telegram');
    expect(here.map((binding) => binding.chatId).sort()).toEqual(['chat-a', 'chat-b']);
    // The conversation-scoped path would have reached only one of them.
    expect(state.bindingsForConversation('conv-1', 'telegram')).toHaveLength(1);
  });

  it('does not cross transports', async () => {
    const state = await store();
    await state.setBinding({
      channel: 'telegram',
      chatId: 'chat-a',
      workspaceId: 'ws',
      conversationId: 'conv-1',
    });
    await state.setBinding({
      channel: 'whatsapp',
      chatId: 'chat-w',
      workspaceId: 'ws',
      conversationId: 'conv-1',
    });
    expect(state.bindingsForWorkspace('ws', 'telegram')).toHaveLength(1);
    expect(state.bindingsForWorkspace('ws')).toHaveLength(2);
  });
});

describe('turn mirroring', () => {
  function wire(conv: ConversationRuntime | undefined): {
    events: SidebarProviderEvents;
    emitted: HostActivityEvent[];
    inner: ReturnType<typeof vi.fn>;
  } {
    const emitted: HostActivityEvent[] = [];
    const inner = vi.fn();
    const events: SidebarProviderEvents = { onGenerationFinished: inner };
    wireTurnMirror(events, { lookup: () => conv, emit: (event) => emitted.push(event) });
    return { events, emitted, inner };
  }

  it('mirrors the assistant answer and keeps the original listener', () => {
    const { events, emitted, inner } = wire(
      conversation([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'the answer' },
      ]),
    );
    events.onGenerationFinished?.('m', 'conv-1');
    expect(emitted).toEqual([{ text: 'the answer', conversationId: 'conv-1', kind: 'turn' }]);
    // Decorating must not swallow the status-bar update it wraps.
    expect(inner).toHaveBeenCalledWith('m', 'conv-1');
  });

  // A turn ends with tool rows after the answer often enough that indexing the
  // last element would mirror an empty string.
  it('walks back past trailing tool rows to find the answer', () => {
    const { events, emitted } = wire(
      conversation([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'the answer' },
        { role: 'tool', content: 'ok', tool_call_id: 't1', name: 'read_file' },
      ]),
    );
    events.onGenerationFinished?.('m', 'conv-1');
    expect(emitted[0]?.text).toBe('the answer');
  });

  it('sends nothing when the turn produced no text', () => {
    const { events, emitted } = wire(
      conversation([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '   ' },
      ]),
    );
    events.onGenerationFinished?.('m', 'conv-1');
    expect(emitted).toEqual([]);
  });

  // PromptRun's /compact turn calls onGenerationFinished with no conversation.
  it('ignores a turn with no conversation id', () => {
    const { events, emitted } = wire(conversation([{ role: 'assistant', content: 'x' }]));
    events.onGenerationFinished?.('m', undefined);
    expect(emitted).toEqual([]);
  });

  it('truncates an answer too long for a chat message', () => {
    const { events, emitted } = wire(
      conversation([{ role: 'assistant', content: 'x'.repeat(5_000) }]),
    );
    events.onGenerationFinished?.('m', 'conv-1');
    expect(emitted[0]!.text.length).toBeLessThan(5_000);
    expect(emitted[0]!.text).toContain('truncated');
  });
});

// mirrorTurn's whole de-duplication rule rests on this answer: a true means a
// chat is already being told, and echoing would deliver the answer twice.
describe('progress ownership', () => {
  function progress(): RemoteAgentProgress {
    return new RemoteAgentProgress(
      new FakeRemoteChannel(),
      new AbortController().signal,
      () => true,
      3_900,
    );
  }

  it('is false until a remote-originated turn claims the conversation', () => {
    const tracker = progress();
    expect(tracker.owns('conv-1')).toBe(false);
    tracker.begin('conv-1', 'chat-a', 'msg-1');
    expect(tracker.owns('conv-1')).toBe(true);
    // Another conversation in the same window is still unclaimed.
    expect(tracker.owns('conv-2')).toBe(false);
  });

  it('releases the conversation once the turn is reported', async () => {
    const tracker = progress();
    tracker.begin('conv-1', 'chat-a', 'msg-1');
    await tracker.finish('conv-1', 'done');
    // The next turn on this conversation may well come from the sidebar.
    expect(tracker.owns('conv-1')).toBe(false);
  });
});
