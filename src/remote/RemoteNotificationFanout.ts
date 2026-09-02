import type { RemoteBinding } from './types';
import type { RemoteRequestStore } from './RemoteRequestStore';

export interface NotificationFanoutDeps {
  store: RemoteRequestStore;
  /** This transport's name. Filtering by it is what keeps a Telegram+WhatsApp
   *  setup from double-delivering: each controller reaches only its own chats. */
  channelName: RemoteBinding['channel'];
  workspaceId: string;
  /** `notifyOutbox` is a durable write only; without this an idle outbox would
   *  sit on the item until some unrelated retry woke the delivery loop. */
  kick: () => void;
  /** Whether a live remote progress message already reports this turn. */
  ownsProgress: (conversationId: string) => boolean;
}

/**
 * Who hears a host-originated message, and what silences it.
 *
 * Split from RemoteController because addressing is a different question from
 * admission and execution: the controller decides whether work runs, this
 * decides who is told about it. Every method returns the number of chats
 * reached — notify_user reports that straight to the model, so a silent zero
 * is what stops the agent claiming it notified a user whose phone never buzzed.
 *
 * Both toggles live here and are in memory: a remote switch must not outlive
 * the window it was set from, matching /clanker.
 */
export class RemoteNotificationFanout {
  /** Chats that have run /notify off. */
  private readonly muted = new Set<string>();
  /**
   * Chats that have run /mirror off. Separate from `muted` because the two
   * carry very different volumes: notify_user is rare and agent-authored,
   * while a mirrored turn fires on every answer. Wanting the first without the
   * second is a real preference, not a hypothetical one.
   */
  private readonly unmirrored = new Set<string>();

  constructor(private readonly deps: NotificationFanoutDeps) {}

  setNotify(chatId: string, on: boolean): void {
    if (on) this.muted.delete(chatId);
    else this.muted.add(chatId);
  }

  isNotifyOn(chatId: string): boolean {
    return !this.muted.has(chatId);
  }

  setMirror(chatId: string, on: boolean): void {
    if (on) this.unmirrored.delete(chatId);
    else this.unmirrored.add(chatId);
  }

  isMirrorOn(chatId: string): boolean {
    return !this.unmirrored.has(chatId);
  }

  /** Conversation-scoped: compaction lines, notify_user, "chat cleared". */
  async toConversation(conversationId: string, text: string): Promise<number> {
    return this.send(this.chatsOn(conversationId), text);
  }

  /**
   * Window-scoped news — a model unloaded, the backend restarted.
   *
   * The conversation-keyed sibling cannot carry these: unloading a model
   * affects the window, not one conversation, so addressing it to a single
   * conversation's chats would skip a paired chat bound to a different one and
   * equally affected.
   */
  async toWorkspace(text: string): Promise<number> {
    const bindings = this.deps.store
      .bindingsForWorkspace(this.deps.workspaceId, this.deps.channelName)
      .filter((binding) => !this.muted.has(binding.chatId));
    // A workspace can hold several chats bound to different conversations; a
    // window-scoped notice is one fact and must not arrive twice in one chat.
    return this.send([...new Set(bindings.map((binding) => binding.chatId))], text);
  }

  /**
   * A finished sidebar turn, echoed to the chats bound to its conversation.
   *
   * Declines when a remote progress message already owns the turn: that means
   * the prompt came from a chat, RemoteQueueDrain is reporting it there, and
   * echoing would deliver the same answer twice. Asking the component that
   * holds the progress message is exact, and saves threading an origin flag
   * through the whole turn path to answer the same question worse.
   */
  async mirrorTurn(conversationId: string, text: string): Promise<number> {
    if (this.deps.ownsProgress(conversationId)) return 0;
    const chatIds = this.chatsOn(conversationId).filter((id) => !this.unmirrored.has(id));
    return this.send(chatIds, text);
  }

  private chatsOn(conversationId: string): string[] {
    return this.deps.store
      .bindingsForConversation(conversationId, this.deps.channelName)
      .filter((binding) => !this.muted.has(binding.chatId))
      .map((binding) => binding.chatId);
  }

  private async send(chatIds: string[], text: string): Promise<number> {
    if (chatIds.length === 0) return 0;
    for (const chatId of chatIds) {
      await this.deps.store.notifyOutbox(this.deps.channelName, chatId, text);
    }
    this.deps.kick();
    return chatIds.length;
  }
}
