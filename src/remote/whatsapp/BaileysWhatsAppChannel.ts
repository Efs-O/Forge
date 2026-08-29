import {
  DisconnectReason,
  extractMessageContent,
  makeWASocket,
  type WASocket,
  type WAMessage,
} from '@whiskeysockets/baileys';
import type { RemoteChannel, RemoteInboundDisposition, RemoteInboundEvent } from '../types';
import type { WhatsAppAuthStore, WhatsAppAuthSession } from './WhatsAppAuthStore';

const TEXT_CHUNK_LIMIT = 4096;
interface SilentLogger {
  level: string;
  child(): SilentLogger;
  trace(): void;
  debug(): void;
  info(): void;
  warn(): void;
  error(): void;
}
const SILENT_LOGGER: SilentLogger = {
  level: 'silent',
  child: () => SILENT_LOGGER,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface BaileysWhatsAppChannelOptions {
  authStore: WhatsAppAuthStore;
  onError: (message: string) => void;
  onPairingCode: (code: string) => void;
}

/** Experimental outbound-WebSocket linked-device adapter. */
export class BaileysWhatsAppChannel implements RemoteChannel {
  readonly name = 'whatsapp' as const;
  private handler: ((event: RemoteInboundEvent) => Promise<RemoteInboundDisposition>) | undefined;
  private socket: WASocket | undefined;
  private auth: WhatsAppAuthSession | undefined;
  private signal: AbortSignal | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private connecting: Promise<void> | undefined;
  private inboundTail: Promise<void> = Promise.resolve();
  private linkingNoticeShown = false;
  private reconnectAttempts = 0;
  private connected = false;

  constructor(private readonly options: BaileysWhatsAppChannelOptions) {}

  onEvent(handler: (event: RemoteInboundEvent) => Promise<RemoteInboundDisposition>): {
    dispose(): void;
  } {
    this.handler = handler;
    return { dispose: () => (this.handler = undefined) };
  }

  async start(signal: AbortSignal): Promise<void> {
    this.signal = signal;
    signal.addEventListener('abort', () => this.close(), { once: true });
    await this.connect();
  }

  async send(
    chatId: string,
    text: string,
    options?: { correlationId?: string; signal?: AbortSignal },
  ): Promise<void> {
    const socket = this.socket;
    if (!socket || this.signal?.aborted || options?.signal?.aborted) {
      throw new Error('Forge WhatsApp transport is not connected.');
    }
    const suffix = options?.correlationId
      ? `\n\nReply exactly:\nAPPROVE ${options.correlationId}\nor\nDENY ${options.correlationId}`
      : '';
    const chunks = splitText(`${text}${suffix}`);
    for (const chunk of chunks) {
      if (this.signal?.aborted || options?.signal?.aborted) {
        throw new Error('Forge WhatsApp send was cancelled.');
      }
      await socket.sendMessage(chatId, { text: chunk });
    }
  }

  async requestPairingCode(phoneNumber: string): Promise<string> {
    if (!/^\d{7,15}$/.test(phoneNumber)) {
      throw new Error('WhatsApp phone number must contain 7-15 digits including country code.');
    }
    if (!this.socket || !this.auth || this.signal?.aborted) {
      throw new Error('Forge WhatsApp transport is not running.');
    }
    if (this.auth.state.creds.registered) {
      throw new Error('Forge WhatsApp is already linked. Unlink it before pairing another device.');
    }
    const code = await this.socket.requestPairingCode(phoneNumber);
    this.options.onPairingCode(code);
    return code;
  }

  async unlink(): Promise<void> {
    this.handler = undefined;
    const socket = this.socket;
    if (socket && this.auth?.state.creds.registered) await socket.logout().catch(() => undefined);
    this.close();
    await this.auth?.clear();
    this.auth = undefined;
  }

  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    const linked = this.auth?.state.creds.registered === true;
    if (!linked) return { ok: false, detail: 'Linked-device authentication is not configured.' };
    return this.connected
      ? { ok: true, detail: 'Linked device is connected.' }
      : { ok: false, detail: 'Linked-device authentication exists, but the socket is offline.' };
  }

  private async connect(): Promise<void> {
    if (this.connecting || this.signal?.aborted) return this.connecting;
    const operation = this.openSocket();
    this.connecting = operation.finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private async openSocket(): Promise<void> {
    this.auth ??= await this.options.authStore.load();
    const socket = makeWASocket({
      auth: this.auth.state,
      emitOwnEvents: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      logger: SILENT_LOGGER,
    });
    this.socket = socket;
    socket.ev.on('creds.update', this.auth.saveCreds);
    socket.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const message of messages) {
        this.inboundTail = this.inboundTail
          .then(() => this.receive(message))
          .catch((err) =>
            this.options.onError(
              `Forge WhatsApp event handling failed: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
      }
    });
    socket.ev.on('connection.update', (update) => {
      if (update.qr && !this.auth?.state.creds.registered && !this.linkingNoticeShown) {
        this.linkingNoticeShown = true;
        this.options.onError(
          'Forge WhatsApp needs linking. Run “Forge: Link WhatsApp Device” locally.',
        );
      }
      if (update.connection === 'open') {
        this.connected = true;
        this.reconnectAttempts = 0;
      }
      if (update.connection !== 'close' || this.socket !== socket) return;
      this.connected = false;
      this.socket = undefined;
      const code = disconnectStatus(update.lastDisconnect?.error);
      if (code === DisconnectReason.loggedOut) {
        this.options.onError('Forge WhatsApp was logged out. Link the device again locally.');
        return;
      }
      if (code === DisconnectReason.connectionReplaced) {
        this.options.onError('Forge WhatsApp connection was replaced; inbound control stopped.');
        return;
      }
      this.scheduleReconnect();
    });
  }

  private async receive(message: WAMessage): Promise<void> {
    if (!this.handler || message.key.fromMe) return;
    const event = toRemoteEvent(message);
    if (!event) return;
    const disposition = await this.handler(event);
    if (disposition.kind === 'retry') {
      this.options.onError(
        `Forge WhatsApp could not durably admit an event and may require resend: ${disposition.reason}`,
      );
    }
  }

  private scheduleReconnect(): void {
    if (this.signal?.aborted || this.reconnectTimer) return;
    const delay = Math.min(2_000 * 2 ** Math.min(this.reconnectAttempts++, 5), 60_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch((err) => {
        this.options.onError(
          `Forge WhatsApp reconnect failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.scheduleReconnect();
      });
    }, delay);
  }

  private close(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    this.connected = false;
    socket?.end(new Error('Forge WhatsApp transport stopped.'));
  }
}

export function toRemoteEvent(message: WAMessage): RemoteInboundEvent | undefined {
  const jid = message.key.remoteJid;
  const id = message.key.id;
  const content = extractMessageContent(message.message);
  const text = content?.conversation ?? content?.extendedTextMessage?.text;
  if (!jid || !id || !text) return undefined;
  const senderId = message.key.participant ?? jid;
  const base = {
    channel: 'whatsapp' as const,
    providerMessageId: id,
    senderId,
    chatId: jid,
    chatType: whatsappChatType(jid),
    receivedAt: timestampMs(message.messageTimestamp),
  };
  const action = /^(APPROVE|DENY) ([0-9a-zA-Z-]{1,256})$/.exec(text);
  if (action) {
    return {
      ...base,
      kind: 'action',
      action: action[1] === 'APPROVE' ? 'approve' : 'deny',
      correlationId: action[2]!,
    };
  }
  return { ...base, kind: 'text', text };
}

function whatsappChatType(jid: string): RemoteInboundEvent['chatType'] {
  if (jid.endsWith('@g.us')) return 'group';
  if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')) return 'private';
  return 'channel';
}

function timestampMs(value: WAMessage['messageTimestamp']): number {
  const seconds = Number(value ?? 0);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds * 1000) : Date.now();
}

function disconnectStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('output' in error)) return undefined;
  const output = (error as { output?: unknown }).output;
  if (!output || typeof output !== 'object' || !('statusCode' in output)) return undefined;
  const status = (output as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' ? status : undefined;
}

function splitText(text: string): string[] {
  if (!text) return [''];
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += TEXT_CHUNK_LIMIT) {
    chunks.push(text.slice(offset, offset + TEXT_CHUNK_LIMIT));
  }
  return chunks;
}
