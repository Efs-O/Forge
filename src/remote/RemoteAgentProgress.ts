import type { AgentProgressEvent } from '../sidebar/AgentProgress';
import type { RemoteChannel } from './types';

const DEFAULT_EDIT_INTERVAL_MS = 1_500;
const MAX_COMMENTARY_CHARS = 2_400;
const MAX_STATUS_CHARS = 500;
const MAX_TOOL_NAME_CHARS = 80;
const DEFAULT_HEADLINE = 'Forge: working…';
const MAX_HEADLINE_CHARS = 160;

type CanDeliver = (chatId: string) => boolean | Promise<boolean>;

interface ActiveProgress {
  chatId: string;
  messageId: string;
  headline: string;
  commentary: string;
  milestone?: string;
  lastText: string;
  timer?: ReturnType<typeof setTimeout>;
  tail: Promise<void>;
  closed: boolean;
}

/** Coalesces visible turn progress into one rate-limited remote message edit. */
export class RemoteAgentProgress {
  private readonly active = new Map<string, ActiveProgress>();

  constructor(
    private readonly channel: RemoteChannel,
    private readonly signal: AbortSignal,
    private readonly canDeliver: CanDeliver,
    private maxMessageChars: number,
    private readonly editIntervalMs = DEFAULT_EDIT_INTERVAL_MS,
    private readonly onError?: (message: string) => void,
  ) {}

  updateMaxMessageChars(maxMessageChars: number): void {
    this.maxMessageChars = maxMessageChars;
  }

  begin(conversationId: string, chatId: string, messageId: string): void {
    this.drop(conversationId);
    this.active.set(conversationId, {
      chatId,
      messageId,
      headline: DEFAULT_HEADLINE,
      commentary: '',
      lastText: DEFAULT_HEADLINE,
      tail: Promise.resolve(),
      closed: false,
    });
  }

  handle(event: AgentProgressEvent): void {
    const state = this.active.get(event.conversationId);
    if (!state || state.closed || !this.channel.editMessage) return;
    if (event.kind === 'commentary') {
      const delta = sanitize(event.text);
      if (!delta) return;
      state.commentary = keepTail(state.commentary + delta, MAX_COMMENTARY_CHARS);
    } else if (event.kind === 'phase') {
      const headline = keepTail(sanitize(event.text ?? '').trim(), MAX_HEADLINE_CHARS);
      const next = headline || DEFAULT_HEADLINE;
      if (next === state.headline) return;
      state.headline = next;
    } else if (event.kind === 'tool') {
      const toolName = sanitizeToolName(event.toolName);
      if (!toolName) return;
      state.milestone = `Running ${toolName}…`;
    } else {
      const status = sanitize(event.text).trim();
      if (!status) return;
      state.milestone = keepTail(status, MAX_STATUS_CHARS);
    }
    this.schedule(event.conversationId, state);
  }

  async finish(conversationId: string, terminalText: string): Promise<void> {
    const state = this.active.get(conversationId);
    if (!state) return;
    state.closed = true;
    if (state.timer) clearTimeout(state.timer);
    delete state.timer;
    await state.tail;
    this.active.delete(conversationId);
    if (this.signal.aborted || !this.channel.editMessage) return;
    if (!(await this.safeCanDeliver(state.chatId))) return;
    await this.channel
      .editMessage(state.chatId, state.messageId, terminalText.slice(0, this.maxMessageChars), {
        signal: this.signal,
      })
      .catch((err) => this.report(err));
  }

  async dispose(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const [conversationId, state] of this.active) {
      state.closed = true;
      if (state.timer) clearTimeout(state.timer);
      pending.push(state.tail);
      this.active.delete(conversationId);
    }
    await Promise.allSettled(pending);
  }

  private schedule(conversationId: string, state: ActiveProgress): void {
    if (state.timer) return;
    state.timer = setTimeout(() => {
      delete state.timer;
      this.queueEdit(conversationId, state);
    }, this.editIntervalMs);
  }

  private queueEdit(conversationId: string, state: ActiveProgress): void {
    const text = render(state, this.maxMessageChars);
    if (text === state.lastText) return;
    state.tail = state.tail
      .then(async () => {
        if (state.closed || this.signal.aborted || !this.channel.editMessage) return;
        if (this.active.get(conversationId) !== state) return;
        if (!(await this.safeCanDeliver(state.chatId))) return;
        await this.channel.editMessage(state.chatId, state.messageId, text, {
          signal: this.signal,
        });
        state.lastText = text;
      })
      .catch((err) => this.report(err));
  }

  private drop(conversationId: string): void {
    const previous = this.active.get(conversationId);
    if (!previous) return;
    previous.closed = true;
    if (previous.timer) clearTimeout(previous.timer);
    this.active.delete(conversationId);
  }

  private report(err: unknown): void {
    this.onError?.(
      `Forge remote progress update failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  private async safeCanDeliver(chatId: string): Promise<boolean> {
    try {
      return await this.canDeliver(chatId);
    } catch (err) {
      this.report(err);
      return false;
    }
  }
}

function render(state: ActiveProgress, maximum: number): string {
  const sections = [state.headline];
  const commentary = state.commentary.trim();
  if (commentary) sections.push(commentary);
  if (state.milestone) sections.push(state.milestone);
  return keepTailWithPrefix(sections.join('\n\n'), maximum, `${state.headline}\n\n`);
}

function sanitize(value: string): string {
  let output = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) {
      output += character;
    }
  }
  return output;
}

function sanitizeToolName(value: string): string {
  return (value.match(/^[a-zA-Z0-9_.:-]+/)?.[0] ?? '').slice(0, MAX_TOOL_NAME_CHARS);
}

function keepTail(value: string, maximum: number): string {
  return value.length <= maximum ? value : `…${value.slice(-(maximum - 1))}`;
}

function keepTailWithPrefix(value: string, maximum: number, prefix: string): string {
  if (value.length <= maximum) return value;
  const room = Math.max(1, maximum - prefix.length);
  return `${prefix}…${value.slice(-(room - 1))}`;
}
