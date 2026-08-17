import type { ModelConfig } from '../config/types';
import {
  inspectRuntimeModelCapabilities,
  type RuntimeModelCapabilities,
} from '../backend/ModelCapabilities';

/** The probe used to fill the cache. Injectable so tests need no HTTP. */
export type CapabilityProbe = (
  baseUrl: string,
  model?: ModelConfig,
) => Promise<RuntimeModelCapabilities>;

/**
 * Per-model memo of the running backend's real capabilities, plus the
 * one-shot warning ledger that goes with it.
 *
 * Only a `runtime`-sourced answer is retained. `inspectRuntimeModelCapabilities`
 * degrades to name heuristics whenever `/props` is unreachable — which is
 * exactly what happens when the first turn of a session races the backend
 * coming up. A heuristic answer reports `likelySupportsThinking: null`, so
 * caching it would strand a thinking-capable model without its thinking kwargs
 * — and warn the user it "does not appear to support" them — for the rest of
 * the session, with no way back short of a config change. Evicting the
 * degraded entry costs one extra `/props` call on the next turn and self-heals.
 */
export class CapabilityCache {
  private readonly entries = new Map<string, Promise<RuntimeModelCapabilities>>();
  private readonly warned = new Set<string>();

  constructor(private readonly probe: CapabilityProbe = inspectRuntimeModelCapabilities) {}

  /**
   * The pending promise — not the resolved value — is what's stored, so
   * concurrent turns on the same model share a single probe rather than
   * stampeding `/props`.
   */
  get(model: ModelConfig, baseUrl: string): Promise<RuntimeModelCapabilities> {
    const cached = this.entries.get(model.name);
    if (cached) return cached;
    const pending = this.probe(baseUrl, model).then((caps) => {
      // Guard the delete: clear() or a newer probe may have replaced this
      // entry while the fetch was still in flight.
      if (caps.source !== 'runtime' && this.entries.get(model.name) === pending) {
        this.entries.delete(model.name);
      }
      return caps;
    });
    this.entries.set(model.name, pending);
    return pending;
  }

  /** Show `message` the first time `key` is seen; a no-op after that. */
  warnOnce(key: string, message: string, show: (message: string) => void): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    show(message);
  }

  /** Drop everything. Called when config changes redefine what a model is. */
  clear(): void {
    this.entries.clear();
    this.warned.clear();
  }
}
