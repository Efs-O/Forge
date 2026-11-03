/**
 * Health polling for a llama-server this window adopted rather than spawned.
 *
 * Split out of `DirectBackend`. An adopted process has no child handle, so its
 * death cannot be observed through an 'exit' event — polling is the only signal
 * that the backend went away, and the slot must be freed when it does.
 *
 * `/health` alone decides liveness, and it must miss **twice in a row** before
 * the server is called gone. `/slots` is not a liveness signal: llama.cpp puts a
 * `/slots` request on the server's own main loop and waits for the answer, and
 * that loop only drains its queue between `update_slots` passes — so one long
 * prompt read (a prefill of `n_batch` 4096-16384 tokens on a partly-offloaded
 * model) keeps `/slots` past the probe timeout while the server is perfectly
 * alive. `/health` is answered on llama.cpp's HTTP thread pool, so a busy
 * server still answers it, and two consecutive misses is what a death looks
 * like. Getting this wrong is not cosmetic: `reconcileDeadSlot` frees the slot
 * and `freeSlot` (`poolSlots.ts`) returns that port to the pool's free list
 * while the other window's process still holds it — every window computes the
 * same fixed port set — so the next load of a *different* model gets that port
 * and `DirectBackend`'s start path (`startLlamaServer`, reached from `hotSwap`)
 * refuses it as the wrong model (ledger BL-013, found by the 2026-10-30 hunt).
 */

const POLL_INTERVAL_MS = 5000;
const PROBE_TIMEOUT_MS = 3000;
/** Consecutive `/health` misses that mean the server is gone rather than busy. */
const HEALTH_FAILURES_BEFORE_LOSS = 2;

export interface AdoptedMonitorOptions {
  baseUrl: string;
  /** Appends a line to the server output channel. */
  log: (line: string) => void;
  /** The server missed `/health` twice in a row: treat the backend as gone. */
  onLost: () => void;
  /** Injected for tests; the host's own `fetch` otherwise. */
  fetchImpl?: typeof fetch;
  /** Overridable for tests; `POLL_INTERVAL_MS` otherwise. */
  pollIntervalMs?: number;
  /** Overridable for tests; `PROBE_TIMEOUT_MS` otherwise. */
  probeTimeoutMs?: number;
  /** Overridable for tests; `HEALTH_FAILURES_BEFORE_LOSS` otherwise. */
  healthFailuresBeforeLoss?: number;
}

export function startAdoptedServerMonitor(
  options: AdoptedMonitorOptions,
): ReturnType<typeof setInterval> {
  const probeFetch = options.fetchImpl ?? globalThis.fetch;
  const probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const failuresBeforeLoss = options.healthFailuresBeforeLoss ?? HEALTH_FAILURES_BEFORE_LOSS;
  const intervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  let healthMisses = 0;
  let lost = false;
  /** One check at a time: `/health` then `/slots` can take up to two probe
   *  timeouts, which is longer than the poll interval on a busy server, and
   *  stacking checks would only add load to the server being checked. */
  let checking = false;
  const probe = (path: string): Promise<Response> =>
    probeFetch(`${options.baseUrl}${path}`, { signal: AbortSignal.timeout(probeTimeoutMs) });
  const stamp = (): string => new Date().toLocaleTimeString();

  const check = async (): Promise<void> => {
    if (lost || checking) return;
    checking = true;
    try {
      // `/health` first and on its own: a refused or timing-out `/slots` must
      // not be able to speak for the server's liveness.
      let healthError = '';
      try {
        const healthRes = await probe('/health');
        if (!healthRes.ok) healthError = `HTTP ${healthRes.status}`;
      } catch (err) {
        healthError = err instanceof Error ? err.message : String(err);
      }
      // `/slots` is read for the slot and context line the owner watches. A
      // server that is mid-prefill does not answer it, and that is said as
      // busy rather than as a death.
      let slotsPart = `slots: busy, no answer within ${probeTimeoutMs} ms`;
      let ctx = '';
      try {
        const slotsRes = await probe('/slots');
        if (slotsRes.ok) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- /slots is untyped llama.cpp JSON
          const slots: any[] = (await slotsRes.json()) as any[];
          const active = slots.filter((s) => s.state === 1).length;
          const total = slots.length;
          slotsPart = total ? `slots: ${active}/${total} active` : '';
          ctx = slots[0] ? `${slots[0].n_past ?? 0}/${slots[0].n_ctx ?? '?'} ctx` : '';
        } else if (slotsRes.status === 501 || slotsRes.status === 404) {
          // A server run with --no-slots never offers this endpoint: say
          // nothing about slots, as before, rather than a 501 every 5 s.
          slotsPart = '';
          ctx = '';
        } else {
          slotsPart = `slots: HTTP ${slotsRes.status}`;
        }
      } catch {
        // The busy line above stands; it says nothing about liveness.
      }
      if (!healthError) {
        healthMisses = 0;
        options.log(
          [`[${stamp()}] llama-server healthy`, slotsPart, ctx].filter(Boolean).join(' | '),
        );
        return;
      }
      healthMisses += 1;
      if (healthMisses < failuresBeforeLoss) {
        options.log(
          `[${stamp()}] llama-server /health did not answer (${healthError}); ` +
            'checking again before calling it gone.',
        );
        return;
      }
      lost = true;
      options.log(`\n[${stamp()}] llama-server stopped or unreachable.`);
      options.onLost();
    } finally {
      checking = false;
    }
  };

  return setInterval(() => void check(), intervalMs);
}
