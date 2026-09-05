/**
 * Host-side notifications the sidebar raises as a turn progresses.
 *
 * Defined apart from `AgentLoop` so collaborators (turn modules, the session
 * timer wiring) can depend on the shape without importing the loop itself.
 * `AgentLoop` re-exports it, so existing import sites are unchanged.
 */
export interface SidebarProviderEvents {
  onGenerationStarted?: (modelName: string | null, conversationId?: string) => void;
  onGenerationFinished?: (
    modelName: string | null,
    conversationId?: string,
    finalText?: string,
  ) => void;
  onBackendError?: (message: string) => void;
  /**
   * A turn ended in failure rather than an answer — a dead backend, a
   * transport error, a spawn that timed out.
   *
   * Distinct from `onBackendError`, which only reaches the status bar and the
   * webview. A turn that dies has to reach whoever was waiting on it, and on
   * 2026-09-05 that was a phone: a stale-port fetch failure ended a monitoring
   * loop, the sidebar rendered an error nobody was sitting in front of, and
   * two hours passed before anyone found out. Silence and "still working"
   * must not look the same.
   */
  onTurnFailed?: (conversationId: string | undefined, message: string) => void;
  onBackendReady?: (modelName: string | null) => void;
  onBackendStopped?: (modelName: string | null) => void;
  onConversationSwitched?: (modelName: string | null) => void;
}
