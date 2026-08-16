/**
 * A tool call whose arguments were cut off mid-generation.
 *
 * llama-server with `--jinja` runs its chat parser over the model's output once
 * generation stops. When the model ran out of room mid-argument the JSON is
 * unterminated, the parser throws, and the server answers HTTP 500 with
 * "Failed to parse tool call arguments as JSON" — the same message it uses for
 * a genuinely malformed call. The two need opposite responses: a malformed call
 * means the model cannot drive this tool protocol (fall back to the prompt
 * format), a truncated one means the model asked for more output than the
 * context had room for (retry smaller). Conflating them made Forge downgrade a
 * perfectly capable model and then re-issue the same oversized request.
 *
 * Lives in `llm/` rather than `agent/` because both the stream client and the
 * agent loop raise it, and `llm/` must not import from `agent/`.
 */
export class ToolCallTruncatedError extends Error {
  readonly toolName: string | undefined;
  readonly toolCallId: string | undefined;
  /** Whatever arguments text arrived before the cut. Empty when the server failed before streaming. */
  readonly partialArguments: string;
  readonly finishReason: string | null;
  /** Best estimate of how many bytes of arguments were emitted before the cut. */
  readonly approxBytes: number;

  constructor(init: {
    toolName?: string | undefined;
    toolCallId?: string | undefined;
    partialArguments?: string;
    finishReason?: string | null;
    approxBytes?: number;
    message?: string;
  }) {
    const partial = init.partialArguments ?? '';
    const bytes = init.approxBytes ?? partial.length;
    super(
      init.message ??
        `Tool call${init.toolName ? ` to ${init.toolName}` : ''} was truncated after ${bytes} bytes of arguments.`,
    );
    this.name = 'ToolCallTruncatedError';
    this.toolName = init.toolName;
    this.toolCallId = init.toolCallId;
    this.partialArguments = partial;
    this.finishReason = init.finishReason ?? null;
    this.approxBytes = bytes;
  }
}

export function isToolCallTruncatedError(err: unknown): err is ToolCallTruncatedError {
  return err instanceof ToolCallTruncatedError;
}

/**
 * nlohmann/json phrases that mean the payload ENDED early, as opposed to being
 * structurally wrong. llama-server embeds the raw parser message in its 500
 * body, so this is how a truncation is told apart from real malformed JSON when
 * the failure arrives as an HTTP status and Forge never saw the partial deltas.
 */
const TRUNCATION_MARKERS = [
  'missing closing quote',
  'unexpected end of input',
  'unexpected end of string',
];

export function isTruncationParseError(message: string): boolean {
  const lower = message.toLowerCase();
  return TRUNCATION_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Pulls the byte offset out of "parse error at line 1, column 10509". That
 * column is how far the model got before the cut — the only size signal
 * available when the server fails the whole request instead of streaming.
 */
export function parseErrorColumn(message: string): number | undefined {
  const match = /column (\d+)/i.exec(message);
  if (!match?.[1]) return undefined;
  const column = Number.parseInt(match[1], 10);
  return Number.isFinite(column) ? column : undefined;
}

/** True when `text` is not parseable as complete JSON — i.e. it was cut off. */
export function argumentsAreIncomplete(text: string): boolean {
  if (text.trim().length === 0) return true;
  try {
    JSON.parse(text);
    return false;
  } catch {
    return true;
  }
}
