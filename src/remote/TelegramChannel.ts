import { TelegramAlbumCoordinator, MAX_TELEGRAM_IMAGES_PER_MESSAGE } from './TelegramAlbumBuffer';
import { TelegramAcknowledgement, type EphemeralMessageHandler } from './TelegramAcknowledgement';
import { pollTelegramUpdates, TELEGRAM_CURSOR_KEY } from './TelegramPolling';
export { MAX_TELEGRAM_IMAGES_PER_MESSAGE } from './TelegramAlbumBuffer';
export { splitTelegramText } from './TelegramText';
import type { RemoteChannel, RemoteInboundDisposition, RemoteInboundEvent } from './types';
import { createTelegramSelectionPages } from './TelegramSelectionPagination';
import { postTelegram, TelegramChatQueue } from './telegramSendQueue';
import { TelegramRichDrafts } from './telegramRichDraft';
import { TelegramOutbound } from './TelegramOutbound';

type Fetch = typeof fetch;
export const TELEGRAM_BOT_TOKEN_SECRET = 'forge.remote.telegram.botToken';

/** Native Telegram command menu. Parsing remains transport-independent. */
export const TELEGRAM_BOT_COMMANDS = [
  { command: 'answer', description: 'Answer a live session question by id' },
  { command: 'chat', description: 'Switch to an existing conversation by number or name' },
  { command: 'chats', description: 'List recent conversations' },
  { command: 'clanker', description: 'Set approval-gate mode' },
  { command: 'claude', description: 'Ask a live Claude session; answer returns here' },
  { command: 'codex', description: 'Ask a live Codex session; answer returns here' },
  { command: 'compact', description: 'Compact the conversation' },
  { command: 'contact', description: 'Approve, link, or disable a contact' },
  { command: 'contacts', description: 'List pending or active contacts' },
  { command: 'context', description: 'Context usage and tokens' },
  { command: 'copilot', description: 'Ask a live Copilot session; answer returns here' },
  { command: 'drop', description: 'Drop queued prompt or all' },
  { command: 'help', description: 'Show all Forge commands' },
  {
    command: 'job',
    description: 'Act on a job by number or name: pause, resume, run, delete, chat',
  },
  { command: 'jobs', description: 'List the persistent agent jobs' },
  { command: 'lock', description: 'Lock this remote session' },
  { command: 'mirror', description: 'Echo sidebar answers here on/off' },
  { command: 'model', description: 'List models, or pin one to this chat by number or name' },
  { command: 'new', description: 'Start a new chat here' },
  { command: 'notify', description: 'Agent notifications on/off' },
  { command: 'queue', description: 'List queued prompts' },
  { command: 'ratelimit', description: 'Show/set messages allowed per minute' },
  { command: 'reload', description: 'Reload VS Code window' },
  { command: 'restart', description: 'Restart the pinned model' },
  { command: 'resume', description: 'Continue the current conversation' },
  { command: 'send', description: 'Prepare a confirmed message to a contact' },
  { command: 'sleep', description: 'Suspend this machine (needs /sleep confirm)' },
  { command: 'status', description: 'Session, model, queue' },
  { command: 'stop', description: 'Stop the current request' },
  { command: 'system', description: 'GPU, VRAM by process, RAM, drives' },
  { command: 'tell', description: 'Send a one-way note to claude, codex or copilot' },
  { command: 'timeout', description: 'Show/set session timeout' },
  { command: 'unload', description: "Free memory: release this chat's model" },
  { command: 'unloadall', description: 'Free memory: release every model' },
  { command: 'view', description: 'Replay the last answers in this chat' },
  { command: 'voice', description: 'Spoken replies on/off' },
  { command: 'wake', description: 'Wake-on-LAN details, or arm a wake timer' },
  { command: 'workspace', description: 'List workspaces, or go to one by number' },
] as const;

export interface TelegramChannelOptions {
  token: string;
  getCursor: (key: string) => string | undefined;
  setCursor: (key: string, value: string) => Promise<void>;
  fetch?: Fetch;
  onError?: (message: string) => void;
}

/** Telegram Bot API long polling with disposition-before-cursor ordering. */
export class TelegramChannel implements RemoteChannel {
  readonly name = 'telegram' as const;
  readonly selectionPages = createTelegramSelectionPages((method, body, signal) =>
    this.call(method, body, signal),
  );
  private handler: ((event: RemoteInboundEvent) => Promise<RemoteInboundDisposition>) | undefined;
  private readonly fetchImpl: Fetch;
  private readonly acknowledgement: TelegramAcknowledgement;
  /**
   * correlationId -> message_id of the prompt that carries its keyboard, so a
   * resolved approval can have its buttons removed. Bounded by
   * PROMPT_MESSAGE_LIMIT: an approval nobody ever answers would otherwise leak
   * an entry per prompt for the life of the window.
   */
  private readonly outbound: TelegramOutbound;
  /** Serializes every chat-addressed call so sends cannot overtake each other. */
  private readonly sendQueue = new TelegramChatQueue();
  private readonly albumCoordinator: TelegramAlbumCoordinator;
  /**
   * Wired by the transport manager once the controller's cleanup scheduler
   * exists: reports queued acknowledgements and transient notices for deletion.
   */
  constructor(private readonly options: TelegramChannelOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.outbound = new TelegramOutbound(
      (method, body, signal) => this.call(method, body, signal),
      this.fetchImpl,
      options.token,
      this.sendQueue,
      options.onError,
    );
    this.acknowledgement = new TelegramAcknowledgement(
      (chatId, text, sendOptions) => this.send(chatId, text, sendOptions),
      options.onError,
    );
    this.albumCoordinator = new TelegramAlbumCoordinator({
      handle: async (event) => {
        if (!this.handler) return { kind: 'retry', reason: 'remote event handler is unavailable' };
        try {
          return await this.handler(event);
        } catch (err) {
          return { kind: 'retry', reason: err instanceof Error ? err.message : String(err) };
        }
      },
      acknowledge: (event, disposition, signal) =>
        this.acknowledgement.acknowledge(event, disposition, signal),
      commitCursor: (nextOffset) => this.options.setCursor(TELEGRAM_CURSOR_KEY, String(nextOffset)),
      onError: this.options.onError,
      onOverflow: async (event, signal) => {
        // Private-chat only, matching acknowledgeDisposition: remote
        // notifications are a private-chat convention, so a group/channel album
        // that overflows the 3-image cap is delivered without the notice.
        if (event.chatType !== 'private') return;
        const messageIds = await this.send(
          event.chatId,
          `Forge: albums are limited to ${MAX_TELEGRAM_IMAGES_PER_MESSAGE} images per message — I kept the first ${MAX_TELEGRAM_IMAGES_PER_MESSAGE}. Each image is capped at 10 MiB, 25 MiB total.`,
          { signal },
        ).catch((err) => {
          if (!signal.aborted) {
            this.options.onError?.(
              `Forge Telegram album notice failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          return [];
        });
        this.acknowledgement.notifyEphemeral(event.chatId, messageIds, 'transient');
      },
    });
  }

  onEvent(handler: (event: RemoteInboundEvent) => Promise<RemoteInboundDisposition>): {
    dispose(): void;
  } {
    this.handler = handler;
    return { dispose: () => (this.handler = undefined) };
  }

  setEphemeralMessageHandler(handler: EphemeralMessageHandler | undefined): void {
    this.acknowledgement.setEphemeralHandler(handler);
  }

  async start(signal: AbortSignal): Promise<void> {
    void this.call('setMyCommands', { commands: TELEGRAM_BOT_COMMANDS }, signal).catch((err) => {
      if (!signal.aborted) {
        this.options.onError?.(
          `Forge Telegram command-menu registration failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    });
    void this.poll(signal).catch((err) => {
      if (!signal.aborted) {
        this.options.onError?.(
          `Forge Telegram polling stopped: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  send(...args: Parameters<TelegramOutbound['send']>) {
    return this.outbound.send(...args);
  }
  sendHtml(...args: Parameters<TelegramOutbound['sendHtml']>) {
    return this.outbound.sendHtml(...args);
  }
  sendProgress(...args: Parameters<TelegramOutbound['sendProgress']>) {
    return this.outbound.sendProgress(...args);
  }
  sendInlineKeyboard(...args: Parameters<TelegramOutbound['sendInlineKeyboard']>) {
    return this.outbound.sendInlineKeyboard(...args);
  }
  sendHelp(...args: Parameters<TelegramOutbound['sendHelp']>) {
    return this.outbound.sendHelp(...args);
  }
  handleHelpAction(...args: Parameters<TelegramOutbound['handleHelpAction']>) {
    return this.outbound.handleHelpAction(...args);
  }
  answerCallbackQuery(...args: Parameters<TelegramOutbound['answerCallbackQuery']>) {
    return this.outbound.answerCallbackQuery(...args);
  }
  clearInlineKeyboard(...args: Parameters<TelegramOutbound['clearInlineKeyboard']>) {
    return this.outbound.clearInlineKeyboard(...args);
  }
  editMessage(...args: Parameters<TelegramOutbound['editMessage']>) {
    return this.outbound.editMessage(...args);
  }
  deleteMessage(...args: Parameters<TelegramOutbound['deleteMessage']>) {
    return this.outbound.deleteMessage(...args);
  }
  retractPrompt(...args: Parameters<TelegramOutbound['retractPrompt']>) {
    return this.outbound.retractPrompt(...args);
  }

  /**
   * Telegram's rich-draft progress lane, exposed as the `RemoteChannel`
   * capability.
   *
   * The draft preview (`sendRichMessageDraft`) goes out of the chat queue with
   * no in-place 429 wait: drafts are throttled far harder than messages, and a
   * throttled preview parked in the FIFO held every narration behind it for up
   * to three minutes. A preview is replaced by the next one, so dropping it
   * costs nothing.
   */
  readonly richDraft = new TelegramRichDrafts((method, body, signal) =>
    postTelegram(this.fetchImpl, this.options.token, method, body, signal, {
      retryRateLimit: false,
    }),
  );

  resolvePromptKeyboard(...args: Parameters<TelegramOutbound['resolvePromptKeyboard']>) {
    return this.outbound.resolvePromptKeyboard(...args);
  }

  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10_000);
    try {
      await this.call('getMe', {}, abort.signal);
      return { ok: true, detail: 'Bot API authentication succeeded.' };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Bounds how often one update may be redelivered before it is given up on.
   *
   * A `retry` disposition breaks the batch WITHOUT advancing the offset, so
   * Telegram hands back the same update immediately. That is the right answer
   * for a transient host error, and a trap for a permanent one: `/select <n>`
   * on an unrestorable conversation threw on every attempt, and the resulting
   * hot loop produced ~30 inbound events in four seconds until the rate limiter
   * turned them into rejections. The sender saw "rate limit exceeded" and never
   * saw the real cause. Three attempts, then reject with the last error and move
   * on — a poisoned update must never be able to spin.
   */
  private async poll(signal: AbortSignal): Promise<void> {
    return pollTelegramUpdates(signal, {
      call: (method, body, callSignal) => this.call(method, body, callSignal),
      getCursor: this.options.getCursor,
      setCursor: this.options.setCursor,
      getHandler: () => this.handler,
      acknowledge: (event, disposition, eventSignal) =>
        this.acknowledgement.acknowledge(event, disposition, eventSignal),
      albumCoordinator: this.albumCoordinator,
      onError: this.options.onError,
    });
  }

  downloadAttachment(...args: Parameters<TelegramOutbound['downloadAttachment']>) {
    return this.outbound.downloadAttachment(...args);
  }
  downloadAttachmentToFile(...args: Parameters<TelegramOutbound['downloadAttachmentToFile']>) {
    return this.outbound.downloadAttachmentToFile(...args);
  }
  sendPhoto(...args: Parameters<TelegramOutbound['sendPhoto']>) {
    return this.outbound.sendPhoto(...args);
  }
  sendVoice(...args: Parameters<TelegramOutbound['sendVoice']>) {
    return this.outbound.sendVoice(...args);
  }

  /**
   * Every Bot API call, in its chat's lane. Calls that name no chat -- the
   * `getUpdates` long poll, `getMe`, `setMyCommands` -- run unqueued, so
   * inbound polling is never held up behind an outbound send.
   */
  private call(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const chatId = body.chat_id === undefined ? undefined : String(body.chat_id);
    return this.sendQueue.run(chatId, () =>
      postTelegram(this.fetchImpl, this.options.token, method, body, signal),
    );
  }
}
