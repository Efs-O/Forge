/**
 * Host-originated news worth telling a paired remote chat about.
 *
 * Forge's outbound surface used to be three hooks — compaction, notify_user,
 * and streamed progress — so anything else the window did (unloading a model,
 * restarting the backend, finishing a turn nobody asked for from a chat) left
 * the window silently. This is the fourth, and it is deliberately one event
 * rather than one per action: every case is "the host did something and nobody
 * outside heard", and a hook per verb would multiply the wiring without
 * telling a transport anything more.
 */
export interface HostActivityEvent {
  /** Ready to send. The host phrases it; transports do not compose text. */
  text: string;
  /**
   * Absent means window-scoped — it reaches every chat bound to this
   * workspace. Unloading a model is a property of the window, not of whichever
   * conversation happened to be in front, and addressing it to one
   * conversation would skip a paired chat bound to a different one.
   */
  conversationId?: string;
  /**
   * `turn` marks the echo of a finished answer — the one kind a chat may
   * already have seen, and the one `/mirror off` silences. Everything else is
   * a state change the user asked nothing about, so it rides `/notify` with
   * compaction and notify_user. Without the distinction, muting the answers
   * would also mute "chat cleared", which is not what either switch means.
   */
  kind?: 'turn';
}

export type HostActivityListener = (event: HostActivityEvent) => void;
