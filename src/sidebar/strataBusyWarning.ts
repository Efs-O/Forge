import type { ModelConfig } from '../config/types';
import { sharedModelSlots } from '../backend/strataStatus';
import type { HostToWebview } from './messageBridge';
import { getLogger } from '../util/logger';

/** Start a turn-scoped hint without putting the Strata status read on its path. */
export function startStrataBusyWarning(
  model: ModelConfig,
  conversationId: string,
  streamingConversationIds: ReadonlySet<string>,
  post: (message: HostToWebview) => void,
  signal?: AbortSignal,
  fetchImpl?: typeof fetch,
): void {
  void sharedModelSlots(model, {
    ...(signal ? { signal } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  })
    .then((slots) => {
      if (!slots) return;
      // Status counts generation in progress; chats between model requests (for
      // example, running a tool) are absent and can make this hint miss load.
      // Strata 0.1.52 has no session/slot field. If the status answer arrives
      // after this turn's own first request reached Strata, that request is
      // counted too, and the hint can fire one chat early.
      const otherStreaming = [...streamingConversationIds].filter(
        (id) => id !== conversationId,
      ).length;
      const busy = Math.max(slots.inFlight, otherStreaming);
      if (busy < slots.capacity) return;
      post({
        type: 'notice',
        severity: 'warning',
        conversationId,
        message: `Strata is already serving ${busy} chat(s), its limit at full speed is ${slots.capacity}. This chat will share the engine, and every running chat will slow down.`,
      });
    })
    .catch((err: unknown) => {
      getLogger().debug(
        `[StrataBusyWarning] warning check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
}
