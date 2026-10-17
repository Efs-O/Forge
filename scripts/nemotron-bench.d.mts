export interface BenchOptions {
  help?: true;
  baseUrl?: string;
  model?: string;
  quant?: string;
  output?: string;
  greekEval?: string;
  greekMaxTokens?: number;
  determinism?: number;
  rowsOut?: string;
  forceRowsOut?: boolean;
  greekNoSystem?: boolean;
  gguf?: string;
}

export function options(
  args: readonly string[],
  root: string,
  exists: (path: string) => boolean,
): BenchOptions;

export function greekMessages(
  question: string,
  systemPrompt: string | undefined,
): Array<{ role: 'system' | 'user'; content: string }>;

export function greekSystemInfo(
  rows: readonly { system?: unknown }[],
  disabled: boolean,
): { mode: 'none' | 'row'; prompt?: string; sha256: string | null };
