/**
 * The one hop between the backend pool and anything that wants to know a model
 * server just came up (today: the Monitor panel's auto-open). Deliberately free
 * of `vscode` and `src/monitor` imports: the pool calls this from the backend,
 * and a listener is what keeps `BackendPool` from having to import the panel.
 */

type Listener = (modelName: string) => void;

let listener: Listener | undefined;

/** One listener per window (the Monitor's auto-open); undefined clears it. */
export function setModelServerReadyListener(next: Listener | undefined): void {
  listener = next;
}

export function notifyModelServerReady(modelName: string): void {
  listener?.(modelName);
}
