/** Validated configuration for the optional Telegram contact workflow. */
export interface RemoteContactsConfig {
  enabled: boolean;
  web: {
    enabled: boolean;
    max_results: number;
    max_fetch_bytes: number;
    timeout_ms: number;
  };
}
