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
   * Everything unkinded is a state change the user asked nothing about, so it
   * rides `/notify` with compaction and notify_user. Without the distinction,
   * muting the answers would also mute "chat cleared", which is not what
   * either switch means.
   *
   * `turn` marks the echo of a finished answer; `failure` marks a turn that
   * ended without one. Both concern a single turn, and both can duplicate
   * something a chat already saw, so each declines when a remote progress
   * message already owns that turn. They differ in what silences them:
   * `/mirror off` is about not wanting answers repeated, and must never
   * suppress the news that the work stopped.
   */
  kind?: 'turn' | 'failure';
}

export type HostActivityListener = (event: HostActivityEvent) => void;
