/**
 * Host → webview model-picker message shapes: the configured models with their
 * labels, routing groups, request profiles and local residency.
 */

/**
 * Local backend state for the picker's readiness dot.
 *
 * - `ready`   — resident and serving; the next send starts immediately.
 * - `loading` — resident but still spawning.
 * - `cold`    — not resident; the next send pays a full model load.
 */
export type ModelResidency = 'ready' | 'loading' | 'cold';

export interface ModelEntry {
  name: string;
  /** Config `display_name`, shown in place of `name`; `name` stays the id sent back. */
  displayName?: string;
  provider: string;
  /** Presentation-only category calculated by the extension host. */
  group?: string;
  profiles?: readonly string[];
  /**
   * Absent when residency is not a meaningful concept for this model — every
   * remote route, including Ollama *cloud* models, which reach the daemon on
   * localhost but hold no VRAM here. Rendering those as `cold` would advertise
   * a load cost that does not exist, so they get no dot at all.
   */
  residency?: ModelResidency;
}
export interface ModelsMsg {
  type: 'models';
  models: ModelEntry[];
  active: string | null;
}
