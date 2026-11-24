/**
 * The one hop between the backend pool and anything that wants to know a model
 * server just came up (today: the Monitor panel's auto-open). Imports nothing
 * from `vscode` or `src/monitor` — only the logger — so every backend path can
 * call it cheaply, and the listener is what keeps `BackendPool` from having to
 * import the panel.
 */

import { getLogger } from '../util/logger';

const log = getLogger();

type Listener = (modelName: string) => void;

let listener: Listener | undefined;

/** One listener per window (the Monitor's auto-open); undefined clears it. */
export function setModelServerReadyListener(next: Listener | undefined): void {
  listener = next;
}

/** Never throws: both callers sit on a start path — in `startSlot`'s `.then` and
 *  inside `prepareExternalForRequest` — so a listener that failed (a webview that
 *  could not be created) would be handled as a model server that failed to start. */
export function notifyModelServerReady(modelName: string): void {
  if (!listener) return;
  try {
    listener(modelName);
  } catch (error) {
    log.error(`[modelServerReady] listener failed for "${modelName}"`, error);
  }
}
