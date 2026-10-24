import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as YAML from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runStrataModeCommand } from '../../src/config/StrataMode';
import { handleRemoteModelCommand } from '../../src/remote/remoteModelCommands';
import type { RemoteCommandContext } from '../../src/remote/RemoteCommandHandler';
import type { RemoteInboundEvent } from '../../src/remote/types';
import { TELEGRAM_BOT_COMMANDS } from '../../src/remote/TelegramChannel';
import { HELP_TEXT } from '../../src/remote/remoteHelpText';
import { SLASH_COMMANDS } from '../../webview-ui/src/slashCommands';

const CONFIG = (command = '[python, start_strata.py, --mode, pair, --port, "8000"]', active = 'strata') => `# Forge config comment stays.
active_model: ${active}
llama_server:
  binary: /path/to/llama-server
models:
  # Strata launcher entry comment stays.
  - name: strata
    model: strata
    provider: openai-compatible
    endpoint: http://localhost:3333/v1
    unload_path: /unload
    # Launcher args are preserved except start_command[3].
    start_command: ${command}
`;

const tempDirs: string[] = [];

function configFile(contents = CONFIG()): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-strata-mode-'));
  tempDirs.push(directory);
  const file = path.join(directory, 'config.yaml');
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('/strataMode config behavior', () => {
  it('changes only start_command[3], preserving surrounding YAML comments', () => {
    const file = configFile();
    const before = YAML.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;

    const result = runStrataModeCommand(file, undefined, 'solo', () => false, 0);

    const raw = fs.readFileSync(file, 'utf8');
    const after = YAML.parse(raw) as Record<string, unknown>;
    const beforeModel = (before['models'] as Array<Record<string, unknown>>)[0]!;
    const afterModel = (after['models'] as Array<Record<string, unknown>>)[0]!;
    const beforeArgs = beforeModel['start_command'] as string[];
    const afterArgs = afterModel['start_command'] as string[];
    expect(afterArgs).toEqual(beforeArgs.map((arg, index) => index === 3 ? 'solo' : arg));
    expect({ ...afterModel, start_command: beforeArgs }).toEqual(beforeModel);
    expect(raw).toContain('# Forge config comment stays.');
    expect(raw).toContain('# Strata launcher entry comment stays.');
    expect(raw).toContain('# Launcher args are preserved except start_command[3].');
    expect(result).toMatchObject({ changed: true, mode: 'solo', modelName: 'strata' });
  });

  it('writes the pair launch value for multi and returns the plan reply', () => {
    const file = configFile(CONFIG('[python, start_strata.py, --mode, solo, --port, "8000"]'));

    const result = runStrataModeCommand(file, undefined, 'multi', () => true, 2);

    expect((YAML.parse(fs.readFileSync(file, 'utf8')) as { models: Array<{ start_command: string[] }> })
      .models[0]!.start_command[3]).toBe('pair');
    expect(result.message).toBe(
      'Strata mode set to multi (two chats at once, a lone chat ~10-20% slower). It takes effect at the next start: run /unloadModel when no chat is running. 2 chats currently running.',
    );
  });

  it('uses the active chat model when the config has no active_model', () => {
    const file = configFile(CONFIG(undefined, 'null'));

    const result = runStrataModeCommand(file, 'strata', 'status', () => true, 0);

    expect(result.message).toBe('Strata mode for strata: multi; backend is running.');
  });

  it('reports status without writing', () => {
    const file = configFile();

    const result = runStrataModeCommand(file, undefined, 'status', () => false, 0);

    expect(result.message).toBe('Strata mode for strata: multi; backend is not running.');
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
  });

  it('does not write when the requested mode is already configured', () => {
    const file = configFile();

    const result = runStrataModeCommand(file, undefined, 'multi', () => false, 0);

    expect(result.message).toBe('Strata mode is already multi for strata.');
    expect(result.changed).toBe(false);
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
  });

  it.each([
    ['three-element command', '[python, start_strata.py, --mode]'],
    ['non-launcher value', '[python, start_strata.py, --mode, visible]'],
  ])('refuses a %s', (_label, command) => {
    const file = configFile(CONFIG(command));
    const before = fs.readFileSync(file, 'utf8');

    const result = runStrataModeCommand(file, undefined, 'solo', () => false, 0);

    expect(result.message).toBe('Forge: strata has no solo/pair launch mode.');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
  });
});

describe('/stratamode remote command and registration', () => {
  it('runs through the remote model command and commits the durable write before replying', async () => {
    const file = configFile(CONFIG('[python, start_strata.py, --mode, solo, --port, "8000"]'));
    const order: string[] = [];
    const context = {
      configPath: file,
      signal: new AbortController().signal,
      channel: {
        send: vi.fn(async () => {
          order.push('reply');
        }),
      },
      store: { binding: () => ({ conversationId: 'c1' }) },
      host: {
        status: () => ({
          activeConversationId: 'c1',
          conversations: [{ id: 'c1', activeModel: null }],
          requestChains: [],
          streamingConversationIds: ['c1'],
        }),
      },
      isModelLoaded: vi.fn(() => true),
      markCommitted: () => order.push('committed'),
    } as unknown as RemoteCommandContext;
    const event: Extract<RemoteInboundEvent, { kind: 'text' }> = {
      channel: 'telegram',
      kind: 'text',
      providerMessageId: 'strata-1',
      senderId: 'owner',
      chatId: 'chat',
      chatType: 'private',
      receivedAt: 1,
      text: '/stratamode multi',
    };

    await expect(handleRemoteModelCommand('/stratamode', 'multi', event, context)).resolves.toEqual({
      kind: 'handled',
    });

    expect(order).toEqual(['committed', 'reply']);
    expect(context.channel.send).toHaveBeenCalledWith(
      'chat',
      expect.stringContaining('Strata mode set to multi'),
      { signal: context.signal },
    );
    expect((YAML.parse(fs.readFileSync(file, 'utf8')) as { models: Array<{ start_command: string[] }> })
      .models[0]!.start_command[3]).toBe('pair');
  });

  it('registers in the webview palette, Telegram command list, and Telegram help', () => {
    expect(SLASH_COMMANDS).toContainEqual(
      expect.objectContaining({ id: 'strataMode', trigger: 'strataMode' }),
    );
    expect(TELEGRAM_BOT_COMMANDS).toContainEqual(
      expect.objectContaining({ command: 'stratamode' }),
    );
    expect(HELP_TEXT).toContain('/stratamode solo|multi|status');
  });
});
