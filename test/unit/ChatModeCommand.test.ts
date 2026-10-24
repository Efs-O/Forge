import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as YAML from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readChatMode, runChatModeCommand } from '../../src/config/ChatMode';
import { handleRemoteModelCommand } from '../../src/remote/remoteModelCommands';
import type { RemoteCommandContext } from '../../src/remote/RemoteCommandHandler';
import type { RemoteInboundEvent } from '../../src/remote/types';
import { TELEGRAM_BOT_COMMANDS } from '../../src/remote/TelegramChannel';
import { HELP_TEXT } from '../../src/remote/remoteHelpText';
import { SLASH_COMMANDS } from '../../webview-ui/src/slashCommands';
import { mapTelegramCallbackQuery } from '../../src/remote/telegramCallbackMapping';
import { telegramChatType } from '../../src/remote/TelegramInboundMapping';

const STRATA_CONFIG = (mode = 'multi', active = 'strata') => `# Forge config comment stays.
active_model: ${active}
llama_server:
  binary: /path/to/llama-server
  default_num_ctx: 131072
  n_parallel: 4
models:
  # Strata launcher entry comment stays.
  - name: strata
    model: strata
    provider: openai-compatible
    endpoint: http://localhost:3333/v1
    unload_path: /unload
    # Launcher args are preserved except start_command[3].
    start_command: [python, start_strata.py, --mode, ${mode}, --port, "8000"]
`;

const LLAMA_CONFIG = (mode: 'solo' | 'multi' = 'solo') => `active_model: llama
llama_server:
  binary: /path/to/llama-server
  default_num_ctx: 131072
  n_parallel: 4
models:
  - name: llama
    provider: llama.cpp
    gguf_path: /models/llama.gguf
    num_ctx: 131072
    n_parallel: ${mode === 'solo' ? 1 : 2}
`;

const tempDirs: string[] = [];

function configFile(contents: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-chat-mode-'));
  tempDirs.push(directory);
  const file = path.join(directory, 'config.yaml');
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('/chatMode config behavior', () => {
  it('writes the literal multi launcher value and preserves surrounding YAML comments', () => {
    const file = configFile(STRATA_CONFIG('solo'));

    const result = runChatModeCommand(file, undefined, 'multi', () => true, 2);

    const raw = fs.readFileSync(file, 'utf8');
    const parsed = YAML.parse(raw) as { models: Array<{ start_command: string[] }> };
    expect(parsed.models[0]?.start_command[3]).toBe('multi');
    expect(raw).toContain('# Forge config comment stays.');
    expect(raw).toContain('# Strata launcher entry comment stays.');
    expect(raw).toContain('# Launcher args are preserved except start_command[3].');
    expect(result).toMatchObject({ changed: true, mode: 'multi', modelName: 'strata' });
    expect(result.message).toBe(
      'Chat mode set to multi (two chats at once, a lone chat ~10-20% slower). It takes effect at the next start: run /unloadModel when no chat is running. 2 chats currently running.',
    );
  });

  it('names and refuses the retired pair launcher value without writing', () => {
    const file = configFile(STRATA_CONFIG('pair'));
    const before = fs.readFileSync(file, 'utf8');

    const result = runChatModeCommand(file, undefined, 'solo', () => false, 0);

    expect(result.message).toBe(
      'Forge: strata start_command[3] is "pair"; set it to solo or multi.',
    );
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('uses the bound chat model when active_model is absent', () => {
    const file = configFile(STRATA_CONFIG('solo', 'null'));

    const state = readChatMode(file, 'strata', () => true, 0);
    const result = runChatModeCommand(file, 'strata', 'status', () => true, 0);

    expect(state).toMatchObject({ modelName: 'strata', kind: 'strata', mode: 'solo' });
    expect(result.message).toBe('Chat mode for strata: solo; backend is running.');
  });

  it('reports a llama model per-chat context and leaves num_ctx unchanged', () => {
    const file = configFile(LLAMA_CONFIG());

    const result = runChatModeCommand(file, undefined, 'multi', () => false, 0);

    const parsed = YAML.parse(fs.readFileSync(file, 'utf8')) as {
      models: Array<{ num_ctx: number; n_parallel: number }>;
    };
    expect(parsed.models[0]).toMatchObject({ num_ctx: 131072, n_parallel: 2 });
    expect(result.message).toBe(
      'Chat mode set to multi (two chats at once, each with half the context: 65,536 of 131,072 tokens). It takes effect at the next start: run /unloadModel when no chat is running.',
    );
  });

  it('reports the same effective slot count and context used by context budgeting', () => {
    const file = configFile(LLAMA_CONFIG('multi'));

    const state = readChatMode(file, undefined, () => false, 0);
    const result = runChatModeCommand(file, undefined, 'status', () => false, 0);

    expect(state).toMatchObject({ kind: 'llama', mode: 'multi', perChatContext: 65536 });
    expect(result.message).toBe(
      'Chat mode for llama: multi (2 chats, 65,536 tokens each); backend is not running.',
    );
  });

  it('writes n_parallel under spawn when the model has no flat field or spawn block', () => {
    const fixture = LLAMA_CONFIG()
      .replace('  n_parallel: 4\n', '  n_parallel: 1\n')
      .replace('    n_parallel: 1\n', '');
    const file = configFile(fixture);

    const result = runChatModeCommand(file, undefined, 'multi', () => false, 0);

    const parsed = YAML.parse(fs.readFileSync(file, 'utf8')) as {
      models: Array<{ spawn: { n_parallel: number } }>;
    };
    expect(parsed.models[0]?.spawn.n_parallel).toBe(2);
    expect(result.changed).toBe(true);
  });

  it('switches llama slots back to solo and reports the full context', () => {
    const file = configFile(LLAMA_CONFIG('multi'));

    const result = runChatModeCommand(file, undefined, 'solo', () => false, 0);

    const parsed = YAML.parse(fs.readFileSync(file, 'utf8')) as {
      models: Array<{ num_ctx: number; n_parallel: number }>;
    };
    expect(parsed.models[0]).toMatchObject({ num_ctx: 131072, n_parallel: 1 });
    expect(result.message).toBe(
      'Chat mode set to solo (one chat at a time, full 131,072-token context for llama). It takes effect at the next start: run /unloadModel when no chat is running.',
    );
  });

  it('writes a shared YAML spawn alias once and names every sibling model', () => {
    const fixture = `active_model: iq3xxs
llama_server:
  binary: /path/to/llama-server
  default_num_ctx: 131072
  n_parallel: 4
models:
  - name: flashnext
    provider: llama.cpp
    gguf_path: /models/flashnext.gguf
    spawn: &flashnext_spawn
      num_ctx: 131072
      # Shared spawn comment survives.
      n_parallel: 1
  - name: iq3xxs
    provider: llama.cpp
    gguf_path: /models/iq3xxs.gguf
    spawn: *flashnext_spawn
  - name: iq2xs
    provider: llama.cpp
    gguf_path: /models/iq2xs.gguf
    spawn: *flashnext_spawn
`;
    const file = configFile(fixture);

    const result = runChatModeCommand(file, undefined, 'multi', () => false, 0);

    const raw = fs.readFileSync(file, 'utf8');
    const parsed = YAML.parse(raw) as {
      models: Array<{ spawn: { n_parallel: number } }>;
    };
    expect(parsed.models.map((model) => model.spawn.n_parallel)).toEqual([2, 2, 2]);
    expect(parsed.models[0]?.spawn).toBe(parsed.models[1]?.spawn);
    expect(parsed.models[1]?.spawn).toBe(parsed.models[2]?.spawn);
    expect(raw).toContain('# Shared spawn comment survives.');
    expect(result.message).toContain(
      'Also applies to flashnext, iq2xs (they share one spawn block).',
    );
  });

  it('restores the complete config when a higher layer overrides the requested slots', () => {
    const fixture = `active_model: llama
llama_server:
  binary: /path/to/llama-server
  default_num_ctx: 131072
  n_parallel: 4
groups:
  fixed-slots:
    spawn:
      n_parallel: 1
models:
  - name: llama
    provider: llama.cpp
    gguf_path: /models/llama.gguf
    num_ctx: 131072
    n_parallel: 1
    group: fixed-slots
`;
    const file = configFile(fixture);

    const result = runChatModeCommand(file, undefined, 'multi', () => false, 0);

    expect(result.message).toBe(
      'n_parallel for llama is set by another config layer; edit it there.',
    );
    expect(result.changed).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(fixture);
  });

  it('refuses unsupported llama slot counts for status and writes', () => {
    const file = configFile(LLAMA_CONFIG().replace('n_parallel: 1', 'n_parallel: 4'));

    const result = runChatModeCommand(file, undefined, 'multi', () => false, 0);

    expect(result.message).toBe('Forge: llama n_parallel is 4; /chatMode sets 1 or 2.');
    expect(fs.readFileSync(file, 'utf8')).toContain('n_parallel: 4');
  });
});

describe('/chatmode Telegram controls and registration', () => {
  it('shows status buttons and maps a tap back through the typed command argument', async () => {
    const file = configFile(STRATA_CONFIG('solo', 'null'));
    const channel = {
      send: vi.fn(async () => undefined),
      sendInlineKeyboard: vi.fn(async () => undefined),
    };
    const context = {
      configPath: file,
      signal: new AbortController().signal,
      channel,
      store: { binding: () => ({ conversationId: 'c1' }) },
      host: {
        status: () => ({
          activeConversationId: 'c1',
          conversations: [{ id: 'c1', activeModel: 'strata' }],
          requestChains: [],
          streamingConversationIds: [],
        }),
      },
      isModelLoaded: vi.fn(() => false),
      markCommitted: vi.fn(),
    } as unknown as RemoteCommandContext;
    const event: Extract<RemoteInboundEvent, { kind: 'text' }> = {
      channel: 'telegram',
      kind: 'text',
      providerMessageId: 'chatmode-status',
      senderId: 'owner',
      chatId: 'chat',
      chatType: 'private',
      receivedAt: 1,
      text: '/chatmode',
    };

    await handleRemoteModelCommand('/chatmode', undefined, event, context);

    expect(channel.sendInlineKeyboard).toHaveBeenCalledWith(
      'chat',
      'Chat mode for strata: solo; backend is not running.',
      [
        [
          { text: '✓ Solo', callbackData: 'k:chatSolo' },
          { text: 'Multi', callbackData: 'k:chatMulti' },
        ],
        [{ text: '✕ Close', callbackData: 'h:x' }],
      ],
      { signal: context.signal },
    );
    await handleRemoteModelCommand('/chatmode', 'status', { ...event, text: '/chatmode status' }, context);
    expect(channel.sendInlineKeyboard).toHaveBeenCalledTimes(2);

    const mapped = mapTelegramCallbackQuery(
      {
        id: 'tap',
        data: 'k:chatMulti',
        from: { id: 1 },
        message: { message_id: 2, chat: { id: 3, type: 'private' } },
      },
      telegramChatType,
    );
    expect(mapped).toMatchObject({ kind: 'text', text: '/chatmode multi' });
    if (!mapped || mapped.kind !== 'text') throw new Error('Expected typed command callback.');
    const [command, argument] = mapped.text.split(/\s+/);

    await handleRemoteModelCommand(command!, argument, { ...event, text: mapped.text }, context);

    expect(channel.send).toHaveBeenCalledWith(
      'chat',
      expect.stringContaining('Chat mode set to multi'),
      { signal: context.signal },
    );
    expect(channel.sendInlineKeyboard).toHaveBeenCalledTimes(2);
    expect(YAML.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({
      models: [{ start_command: ['python', 'start_strata.py', '--mode', 'multi', '--port', '8000'] }],
    });
  });

  it('sends an unsupported model refusal as plain text without buttons', async () => {
    const file = configFile(STRATA_CONFIG('visible'));
    const channel = {
      send: vi.fn(async () => undefined),
      sendInlineKeyboard: vi.fn(async () => undefined),
    };
    const context = {
      configPath: file,
      signal: new AbortController().signal,
      channel,
      store: { binding: () => ({ conversationId: 'c1' }) },
      host: {
        status: () => ({
          conversations: [{ id: 'c1', activeModel: 'strata' }],
          streamingConversationIds: [],
        }),
      },
    } as unknown as RemoteCommandContext;
    const event: Extract<RemoteInboundEvent, { kind: 'text' }> = {
      channel: 'telegram',
      kind: 'text',
      providerMessageId: 'chatmode-refusal',
      senderId: 'owner',
      chatId: 'chat',
      chatType: 'private',
      receivedAt: 1,
      text: '/chatmode',
    };

    await handleRemoteModelCommand('/chatmode', undefined, event, context);

    expect(channel.send).toHaveBeenCalledWith(
      'chat',
      'Forge: strata has no solo/multi setting.',
      { signal: context.signal },
    );
    expect(channel.sendInlineKeyboard).not.toHaveBeenCalled();
  });

  it('registers the sidebar command, Telegram command and help text', () => {
    expect(SLASH_COMMANDS).toContainEqual(
      expect.objectContaining({ id: 'chatMode', trigger: 'chatMode' }),
    );
    expect(TELEGRAM_BOT_COMMANDS).toContainEqual(
      expect.objectContaining({ command: 'chatmode' }),
    );
    expect(HELP_TEXT).toContain('/chatmode [solo|multi|status]');
  });
});
