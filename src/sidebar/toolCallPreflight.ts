/** Checks that decide a tool call never runs, before approval. */
import type { ToolCall } from '../llm/types';
import type { ToolBudget } from '../tools/ToolBudget';
import type { RegisteredTool, ToolHandlerResult, ToolPermission } from '../tools/ToolRegistry';
import type { ToolRegistry } from '../tools/ToolRegistry';
import { unknownToolResult } from './retiredTools';

export type ToolCallPreflight =
  | { kind: 'refused'; result: ToolHandlerResult; recordFailure: boolean }
  | { kind: 'ready'; args: Record<string, unknown>; reg: RegisteredTool };

export function preflightToolCall(
  tc: ToolCall,
  input: {
    toolRegistry: ToolRegistry;
    allowed: Set<ToolPermission>;
    convId: string | undefined;
    signal: AbortSignal | undefined;
    budget: ToolBudget | undefined;
    unavailableTools: ReadonlyMap<string, string> | undefined;
    clankerMode: boolean;
  },
): ToolCallPreflight {
  let result: ToolHandlerResult;
  let args: Record<string, unknown>;
  if (input.signal?.aborted) {
    result = 'Error: tool execution cancelled';
    return { kind: 'refused', result, recordFailure: false };
  }
  try {
    const parsed: unknown = JSON.parse(tc.function.arguments);
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      const got = parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed;
      result = `Error: ${tc.function.name}: arguments must be a JSON object, got ${got}.`;
      return { kind: 'refused', result, recordFailure: true };
    }
    args = parsed as Record<string, unknown>;
  } catch (error) {
    const parserMessage = error instanceof Error ? error.message : String(error);
    result =
      `Error: ${tc.function.name}: the arguments are not valid JSON (${parserMessage}). ` +
      'Write each literal backslash as \\ and resend.';
    return { kind: 'refused', result, recordFailure: true };
  }

  if (tc.function.name === '__tool_call_error__' && typeof args['__error'] === 'string') {
    // The parser's own refusal is a failure by definition, and every consumer
    // that reads a result's text keys on the `Error:` prefix, so the marker is
    // added when the model sent the text without it.
    const reported = args['__error'];
    result = reported.startsWith('Error:') ? reported : `Error: ${reported}`;
    return { kind: 'refused', result, recordFailure: true };
  }

  // Registered but withheld from this model (e.g. view_image without a
  // projector). The tool would still execute if called blind — say why
  // instead, so the model does not go hunting for a substitute.
  const unavailable = input.unavailableTools?.get(tc.function.name);
  if (unavailable) {
    return { kind: 'refused', result: unavailable, recordFailure: false };
  }

  const reg = input.toolRegistry.get(tc.function.name);
  if (!reg) {
    result = unknownToolResult(
      tc.function.name,
      input.toolRegistry,
      input.allowed,
      input.budget,
      input.convId,
      input.unavailableTools,
    );
    return { kind: 'refused', result, recordFailure: false };
  }
  const invalid = input.toolRegistry.invalidArgs(reg, args, {
    ...(input.convId !== undefined ? { conversationId: input.convId } : {}),
    clankerMode: input.clankerMode,
  });
  if (invalid) {
    return { kind: 'refused', result: invalid, recordFailure: true };
  }
  const budgetBlock = input.budget?.check(tc.function.name);
  if (budgetBlock) {
    return { kind: 'refused', result: budgetBlock, recordFailure: false };
  }

  return { kind: 'ready', args, reg };
}
