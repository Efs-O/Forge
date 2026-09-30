/**
 * The out-of-band agent-progress pub/sub.
 *
 * Owns the listener set and the safe dispatch (a failing listener must never
 * take down the turn that raised the event). Extracted from `AgentLoop` (pure
 * move — no behaviour change): the loop keeps `onAgentProgress` /
 * `reportProgress` as one-line delegates so existing callers are unaffected.
 */

import type { AgentProgressEvent, AgentProgressListener } from './AgentProgress';
import { getLogger } from '../util/logger';

const log = getLogger();

export class AgentProgressBus {
  private readonly listeners = new Set<AgentProgressListener>();

  /** Subscribe a listener; returns an unsubscribe handle. */
  onAgentProgress(listener: AgentProgressListener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /**
   * Emit to every listener. A listener that throws is logged and skipped — a
   * progress sink must never abort the turn that produced the event.
   */
  emit(event: AgentProgressEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        log.warn(
          `[AgentLoop] progress listener failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** Drop every listener (used on dispose). */
  clear(): void {
    this.listeners.clear();
  }
}
