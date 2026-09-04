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
  onBackendReady?: (modelName: string | null) => void;
  onBackendStopped?: (modelName: string | null) => void;
  onConversationSwitched?: (modelName: string | null) => void;
}
