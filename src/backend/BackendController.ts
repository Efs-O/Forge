import type { ForgeConfig } from '../config/types';

export interface BackendController {
  /** Start the backend (spawn server or connect to bridge). Resolves when ready. */
  start(): Promise<void>;
  /** Stop the backend and release all resources. */
  stop(): Promise<void>;
  /** Reveal the backend console or log stream. */
  showConsole(): void;
  /** True once the server is confirmed healthy. */
  isReady(): boolean;
  /** Base URL for OpenAI-compatible API calls, e.g. http://127.0.0.1:8080 */
  baseUrl(): string;
  /** Name of the model currently loaded behind baseUrl, if any. */
  loadedModel(): string | null;
  /** Swap to a different model without restarting everything that consumes baseUrl. */
  hotSwap(modelName: string): Promise<void>;
  /** Replace merged Forge config after YAML reload (shared reference with SidebarProvider). */
  applyForgeConfig(next: ForgeConfig): void;
}
