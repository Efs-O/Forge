/**
 * Health polling for a llama-server this window adopted rather than spawned.
 *
 * Split out of `DirectBackend`. An adopted process has no child handle, so its
 * death cannot be observed through an 'exit' event — polling is the only signal
 * that the backend went away, and the slot must be freed when it does.
 */

const POLL_INTERVAL_MS = 5000;
const PROBE_TIMEOUT_MS = 3000;

export interface AdoptedMonitorOptions {
  baseUrl: string;
  /** Appends a line to the server output channel. */
  log: (line: string) => void;
  /** The server stopped answering: treat the backend as gone. */
  onLost: () => void;
}

export function startAdoptedServerMonitor(
  options: AdoptedMonitorOptions,
): ReturnType<typeof setInterval> {
  return setInterval(async () => {
    try {
      const [healthRes, slotsRes] = await Promise.all([
        fetch(`${options.baseUrl}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }),
        fetch(`${options.baseUrl}/slots`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }),
      ]);
      if (!healthRes.ok) throw new Error(`HTTP ${healthRes.status}`);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- /slots is untyped llama.cpp JSON
      const slots: any[] = slotsRes.ok ? ((await slotsRes.json()) as any[]) : [];
      const active = slots.filter((s) => s.state === 1).length;
      const total = slots.length;
      const ctx = slots[0] ? `${slots[0].n_past ?? 0}/${slots[0].n_ctx ?? '?'} ctx` : '';
      const ts = new Date().toLocaleTimeString();
      options.log(
        [`[${ts}] llama-server healthy`, total ? `slots: ${active}/${total} active` : '', ctx]
          .filter(Boolean)
          .join(' | '),
      );
    } catch {
      const ts = new Date().toLocaleTimeString();
      options.log(`\n[${ts}] llama-server stopped or unreachable.`);
      options.onLost();
    }
  }, POLL_INTERVAL_MS);
}
