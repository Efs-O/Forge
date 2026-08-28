import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentLoop, type SidebarProviderEvents } from '../../src/sidebar/AgentLoop';
import type { IBackendPool } from '../../src/backend/BackendPool';
import type { BackendController } from '../../src/backend/BackendController';
import type { ForgeConfig, ModelConfig } from '../../src/config/types';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';
import { slimPersistMessages } from '../../src/sidebar/sessionTypes';
import type { CheckpointStack } from '../../src/checkpoint/CheckpointStack';
import type { KeepUndoCodeLensProvider } from '../../src/sidebar/KeepUndoCodeLens';
import type { ToolFailureTracker } from '../../src/tools/StripTools';
import type { DiffDecorations } from '../../src/sidebar/DiffDecorations';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import type { ChatMessage } from '../../src/llm/types';
import { ageOutImageParts, countImageParts, stripImageParts } from '../../src/sidebar/imageParts';
import {
  imageUnsupportedMessage,
  isImageUnsupportedError,
} from '../../src/llm/imageUnsupportedError';

const { streamModelChatCompletion, inspectRuntimeModelCapabilities } = vi.hoisted(() => ({
  streamModelChatCompletion: vi.fn(),
  inspectRuntimeModelCapabilities: vi.fn().mockResolvedValue({}),
}));

vi.mock('vscode', () => ({
  window: {
    activeTextEditor: undefined,
    createOutputChannel: vi.fn(() => ({
      appendLine: vi.fn(),
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    })),
    showWarningMessage: vi.fn(),
  },
}));

vi.mock('../../src/llm/ChatClient', () => ({ streamModelChatCompletion }));
vi.mock('../../src/backend/ModelCapabilities', () => ({ inspectRuntimeModelCapabilities }));

const PIXEL = 'data:image/png;base64,iVBORw0KGgo=';

function imageMessage(role: ChatMessage['role'], text: string): ChatMessage {
  return {
    role,
    content: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: PIXEL } },
    ],
    ...(role === 'tool' ? { tool_call_id: 'call-1', name: 'view_image' } : {}),
  };
}

function makeConfig(model: Partial<ModelConfig> = {}): ForgeConfig {
  return {
    models: [
      { name: 'test-model', provider: 'llama.cpp', gguf_path: '/models/test.gguf', ...model },
    ],
    active_model: 'test-model',
    llama_server: {},
  } as ForgeConfig;
}

function makeConversation(messages: ChatMessage[] = []): ConversationRuntime {
  return { id: 'conv-1', title: 'Chat', createdAt: 1, updatedAt: 1, messages };
}

function makePool(): IBackendPool {
  const backend: BackendController = {
    start: async () => {},
    stop: async () => {},
    showConsole: () => {},
    isReady: () => true,
    baseUrl: () => 'http://127.0.0.1:8080',
    loadedModel: () => 'test-model',
    hotSwap: async () => {},
    applyForgeConfig: () => {},
  };
  return {
    acquire: async () => backend,
    release: async () => {},
    stopAll: async () => {},
    applyForgeConfig: () => {},
    showConsole: () => {},
    isAnyReady: () => false,
    loadedModelNames: () => [],
    isLoaded: () => false,
  };
}

function makeLoop(config: ForgeConfig, post: (message: unknown) => void): AgentLoop {
  const checkpoints = {
    beginTurn: vi.fn(() => ({
      snapshotBefore: vi.fn(),
      snapshotMissingBefore: vi.fn(),
      prepareWorkspace: vi.fn(async () => ({
        finish: vi.fn(async () => {}),
        discard: vi.fn(async () => {}),
      })),
    })),
    commitTurn: vi.fn(),
    depth: vi.fn().mockReturnValue(0),
  } as unknown as CheckpointStack;

  const events: SidebarProviderEvents = {
    onBackendError: vi.fn(),
    onBackendReady: vi.fn(),
    onGenerationStarted: vi.fn(),
    onGenerationFinished: vi.fn(),
  };

  return new AgentLoop(
    makePool(),
    () => config,
    new ToolRegistry(),
    checkpoints,
    { markPending: vi.fn(), clearPending: vi.fn() } as unknown as KeepUndoCodeLensProvider,
    {} as DiffDecorations,
    {
      shouldStrip: vi.fn().mockReturnValue(false),
      reset: vi.fn(),
      record: vi.fn(),
    } as unknown as ToolFailureTracker,
    events,
    post,
    () => undefined,
    undefined,
    undefined,
    undefined,
    process.cwd(),
  );
}

function replyOnce(sent?: ChatMessage[][]) {
  streamModelChatCompletion.mockImplementation(
    (
      _baseUrl: string,
      request: { messages: ChatMessage[] },
      _model: ModelConfig,
      handlers: {
        onToken: (token: string) => void;
        onDone: (reason: string | null) => void;
        onToolCalls: (calls: unknown[] | null) => void;
      },
    ) => {
      sent?.push(request.messages);
      handlers.onToken('ok');
      handlers.onToolCalls(null);
      handlers.onDone('stop');
    },
  );
}

/** Runs one full turn and returns every `messages` array that reached the client. */
async function runTurn(
  config: ForgeConfig,
  conv: ConversationRuntime,
  prompt = 'what does this show?',
): Promise<{ sent: ChatMessage[][]; posted: Array<Record<string, unknown>> }> {
  const sent: ChatMessage[][] = [];
  replyOnce(sent);
  const posted: Array<Record<string, unknown>> = [];
  const loop = makeLoop(config, (message) => posted.push(message as Record<string, unknown>));
  await loop.runTurn(conv, config.models[0]!, prompt);
  return { sent, posted };
}

function notices(posted: Array<Record<string, unknown>>): string[] {
  return posted
    .filter((message) => message['type'] === 'notice')
    .map((message) => String(message['message']));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('imageParts helpers', () => {
  it('replaces image parts with a note, keeps sibling text, and is identity when clean', () => {
    const messages: ChatMessage[] = [imageMessage('user', 'look at this')];
    const stripped = stripImageParts(messages, { reason: 'no-vision', modelName: 'plain-7b' });
    expect(stripped[0]?.content).toEqual([
      { type: 'text', text: 'look at this' },
      { type: 'text', text: expect.stringContaining('"plain-7b" has no vision projector') },
    ]);
    expect(countImageParts(stripped)).toBe(0);
    // The caller's transcript is never mutated.
    expect(countImageParts(messages)).toBe(1);

    const clean: ChatMessage[] = [{ role: 'user', content: 'hello' }];
    expect(stripImageParts(clean, { reason: 'persist' })).toBe(clean);
  });

  it('counts image parts across messages', () => {
    expect(
      countImageParts([
        imageMessage('user', 'a'),
        { role: 'assistant', content: 'thinking' },
        imageMessage('tool', 'view_image ok'),
      ]),
    ).toBe(2);
    expect(countImageParts([{ role: 'user', content: 'no images' }])).toBe(0);
  });

  it('slimPersistMessages still emits the persist notes, not the no-vision note', () => {
    const persisted = slimPersistMessages([
      imageMessage('user', 'look at this'),
      imageMessage('tool', 'viewed chart.png'),
    ]);
    expect(persisted[0]?.content).toContain('not retained across the reload');
    expect(persisted[0]?.content).toContain('re-attach');
    expect(persisted[1]?.content).toContain('Call view_image again');
    expect(persisted.map((m) => m.content).join('\n')).not.toContain('vision projector');
  });
});

describe('ageOutImageParts', () => {
  const transcript = (): ChatMessage[] => [
    imageMessage('user', 'first prompt with a chart'),
    { role: 'assistant', content: 'a chart' },
    { role: 'user', content: 'second prompt' },
    { role: 'assistant', content: 'sure' },
    { role: 'user', content: 'third prompt' },
  ];

  it('is disabled — same reference — when retention is undefined', () => {
    const messages = transcript();
    expect(ageOutImageParts(messages, undefined)).toBe(messages);
  });

  it('never removes an image from the user turn that introduced it', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'earlier' },
      imageMessage('user', 'here is the chart'),
      { role: 'assistant', content: null, tool_calls: [] },
      { role: 'tool', content: 'ran a tool', tool_call_id: 'c1' },
    ];
    expect(countImageParts(ageOutImageParts(messages, 0))).toBe(1);
  });

  it('ages an image out once later user messages exceed the retention', () => {
    expect(countImageParts(ageOutImageParts(transcript(), 2))).toBe(1);
    const aged = ageOutImageParts(transcript(), 1);
    expect(countImageParts(aged)).toBe(0);
    expect(JSON.stringify(aged)).toContain('Ask the user to re-attach it');
  });

  it('counts user turns, not tool rounds', () => {
    const toolHeavy: ChatMessage[] = [
      imageMessage('user', 'here is the chart'),
      ...Array.from(
        { length: 20 },
        (_, i): ChatMessage => ({ role: 'tool', content: `result ${i}`, tool_call_id: `c${i}` }),
      ),
    ];
    expect(countImageParts(ageOutImageParts(toolHeavy, 0))).toBe(1);
  });

  it('uses a role-aware recovery note for tool images', () => {
    const aged = ageOutImageParts(
      [
        imageMessage('tool', 'viewed it'),
        { role: 'user', content: 'next' },
        { role: 'user', content: 'next again' },
      ],
      0,
    );
    expect(JSON.stringify(aged)).toContain('Call view_image again');
  });
});

describe('isImageUnsupportedError', () => {
  const projectorBody =
    '{"error":{"message":"image input is not supported - hint: if this is unexpected, ' +
    'you may need to provide the mmproj","code":500}}';
  const truncationBody =
    '{"error":{"message":"Failed to parse tool call arguments as JSON: ' +
    '[json.exception.parse_error.101] parse error at line 1, column 10509: missing closing quote"}}';

  it('matches the projector body and not the truncation body', () => {
    expect(isImageUnsupportedError(projectorBody)).toBe(true);
    expect(isImageUnsupportedError(truncationBody)).toBe(false);
  });

  it('carries the HTTP status only when one exists', () => {
    expect(imageUnsupportedMessage('vision-less', 500)).toContain('(HTTP 500)');
    expect(imageUnsupportedMessage('vision-less')).not.toContain('HTTP');
    expect(imageUnsupportedMessage('vision-less')).toContain('mmproj_path');
  });
});

describe('vision history stripping through a real turn', () => {
  it('sends zero image parts and two notes on a non-vision model', async () => {
    const conv = makeConversation([
      imageMessage('user', 'here is a screenshot'),
      { role: 'assistant', content: 'I see it' },
      imageMessage('tool', 'view_image read chart.png'),
    ]);
    const before = JSON.parse(JSON.stringify(conv.messages)) as ChatMessage[];

    const { sent } = await runTurn(makeConfig(), conv);

    expect(sent).toHaveLength(1);
    expect(countImageParts(sent[0]!)).toBe(0);
    const notes = JSON.stringify(sent[0]).split('has no vision projector').length - 1;
    expect(notes).toBe(2);
    // conv.messages keeps the pixels: the images are still in the transcript.
    expect(conv.messages.slice(0, 3)).toEqual(before);
    expect(countImageParts(conv.messages)).toBe(2);
  });

  it('sends the transcript untouched on a vision model', async () => {
    const conv = makeConversation([imageMessage('user', 'here is a screenshot')]);
    const before = JSON.parse(JSON.stringify(conv.messages)) as ChatMessage[];

    const { sent, posted } = await runTurn(
      makeConfig({ mmproj_path: '/models/mmproj-F16.gguf' }),
      conv,
    );

    expect(countImageParts(sent[0]!)).toBe(1);
    expect(JSON.stringify(sent[0])).not.toContain('has no vision projector');
    expect(conv.messages.slice(0, 1)).toEqual(before);
    expect(notices(posted)).toHaveLength(0);
  });

  it('posts a notice on a stripping turn and none when there is nothing to strip', async () => {
    const withImages = await runTurn(
      makeConfig(),
      makeConversation([imageMessage('user', 'screenshot')]),
    );
    expect(notices(withImages.posted)).toHaveLength(1);
    expect(notices(withImages.posted)[0]).toContain('cannot see images');
    expect(notices(withImages.posted)[0]).toContain('1 image(s)');
    expect(notices(withImages.posted)[0]).toContain('capabilities: [vision]');

    const withoutImages = await runTurn(
      makeConfig(),
      makeConversation([{ role: 'user', content: 'plain text only' }]),
    );
    expect(notices(withoutImages.posted)).toHaveLength(0);
  });

  it('posts no notice for an image the compaction window already dropped', async () => {
    const conv = makeConversation([
      imageMessage('user', 'old screenshot'),
      { role: 'assistant', content: 'seen' },
      { role: 'user', content: 'later prompt' },
      { role: 'assistant', content: 'ok' },
    ]);
    conv.compaction = { summary: 'earlier work', fromIndex: 2 };

    const { sent, posted } = await runTurn(makeConfig(), conv);

    expect(countImageParts(sent[0]!)).toBe(0);
    expect(notices(posted)).toHaveLength(0);
  });

  it('repeats the transcript notice every affected turn while the toast fires once', async () => {
    const config = makeConfig();
    const posted: Array<Record<string, unknown>> = [];
    replyOnce();
    const loop = makeLoop(config, (message) => posted.push(message as Record<string, unknown>));
    const conv = makeConversation([imageMessage('user', 'screenshot')]);

    await loop.runTurn(conv, config.models[0]!, 'first');
    await loop.runTurn(conv, config.models[0]!, 'second');

    expect(notices(posted).filter((text) => text.includes('cannot see images'))).toHaveLength(2);
    const vscode = (await import('vscode')) as unknown as {
      window: { showWarningMessage: ReturnType<typeof vi.fn> };
    };
    const visionToasts = vscode.window.showWarningMessage.mock.calls.filter((call) =>
      String(call[0]).includes('cannot see images'),
    );
    expect(visionToasts).toHaveLength(1);
  });
});
