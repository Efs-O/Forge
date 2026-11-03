/**
 * The status-bar and turn-counter events `extension.ts` hands the sidebar.
 *
 * Extracted from `extension.ts` (2026-10-29, lane F2: that file had reached the
 * 500-line gate this repo lints, and wiring the skills service into it needed a
 * real seam first). These five events are one concern — what the user sees in the
 * bar and in the notification budget while a turn runs — and they were the
 * largest inline literal in `activate()`.
 *
 * `refreshSessionTime` and `followSessionTime` are passed as thunks, not values:
 * `extension.ts` reassigns both `let`s after this is called (the sidebar's own
 * wiring installs the real ones), so a value captured here would freeze the
 * no-op initialisation and the bar would never update.
 */
import type { SidebarProviderEvents } from './AgentLoop';

export interface StatusBarTurnEventDeps {
  /** The backend-state indicator. */
  statusBar: {
    setGenerating: (modelName?: string | null) => void;
    setReady: (modelName?: string | null) => void;
    setStopped: (modelName?: string | null) => void;
    setError: (message: string) => void;
  };
  /** The model pool, for the ready/stopped decision. */
  pool: { isAnyReady: () => boolean };
  /** Per-chat notification budget, reset at turn start. */
  userNotifications: { resetTurn: (conversationId: string | undefined) => void };
  /** Models with a turn in flight, keyed by conversation. */
  activeTurnModels: Map<string, string>;
  /** Reads the reassigned `let` at call time; see the file comment. */
  followSessionTime: (conversationId: string | undefined) => void;
  refreshSessionTime: () => void;
}

export function buildStatusBarTurnEvents(deps: StatusBarTurnEventDeps): SidebarProviderEvents {
  const { statusBar, pool, userNotifications, activeTurnModels } = deps;
  return {
    onGenerationStarted: (modelName, conversationId) => {
      if (modelName && conversationId) activeTurnModels.set(conversationId, modelName);
      statusBar.setGenerating(modelName);
      // Turn START, not end: a cancelled or thrown turn never reaches its end,
      // and a leaked counter would silently mute the agent from then on.
      // Unconditional, including the no-conversation key: a conversation-less
      // turn still charges that bucket (notify_user from a /compact summary,
      // send_file with no chat bound), so guarding this call on a defined id
      // would let that budget fill once and never drain again.
      userNotifications.resetTurn(conversationId);
      // The bar follows the chat that just started, so a chat run in the
      // background (`forge.sh --new`) is the one it shows.
      if (conversationId !== undefined) deps.followSessionTime(conversationId);
      deps.refreshSessionTime();
    },
    onGenerationFinished: (modelName, conversationId) => {
      if (conversationId) activeTurnModels.delete(conversationId);
      if (pool.isAnyReady()) statusBar.setReady(modelName);
      else statusBar.setStopped(modelName);
      deps.refreshSessionTime();
    },
    onBackendError: (message) => statusBar.setError(message),
    onBackendReady: (modelName) => statusBar.setReady(modelName),
    onConversationSwitched: (modelName) => {
      if (pool.isAnyReady()) statusBar.setReady(modelName);
      else statusBar.setStopped(modelName);
      // Picking a chat is the user saying which one they want to see.
      deps.followSessionTime(undefined);
      deps.refreshSessionTime();
    },
  };
}
