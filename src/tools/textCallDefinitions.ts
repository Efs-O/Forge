/**
 * Tool calls read out of the model's text, including ones naming a tool this
 * request did not list. The extra definitions are what type such a call's
 * arguments (a non-string parameter arrives as an XML string) and what let a
 * fenced-JSON call through the name filter; the row they report is how the
 * whole `schemas_in_result` switch is monitored.
 */
import type { ToolCall, ToolDefinition } from '../llm/types';
import { extractFallbackToolCalls } from './ToolCallFallback';
import type { StructuredOutputForms } from './StructuredOutputParser';

/** The two loop options this helper reads, declared here so `src/tools` stays
 *  out of `src/agent`'s import graph. `ToolCallingLoopOptions` satisfies it. */
export interface TextCallReporting {
  /** Definitions for registered tools this request does not advertise. */
  getTextCallDefinitions?: () => ToolDefinition[];
  /** Every tool name this round's text gave, and which of them were unlisted. */
  onTextToolCalls?: (names: readonly string[], unlisted: readonly string[]) => void;
}

/** A parse failure is reported under this name, not as a tool the model called. */
const TOOL_CALL_ERROR = '__tool_call_error__';

/**
 * `extractFallbackToolCalls` over the listed definitions plus the text-call
 * ones, then one report row for the names it found. Returns exactly what the
 * fallback parser returned, so nothing about which calls run changes.
 */
export function extractTextCalls(
  rawAssistant: string,
  toolDefinitions: readonly ToolDefinition[],
  forms: StructuredOutputForms,
  options: TextCallReporting,
  offeredToolNames: readonly string[],
): ToolCall[] | null {
  const defs = [...toolDefinitions, ...(options.getTextCallDefinitions?.() ?? [])];
  const calls = extractFallbackToolCalls(rawAssistant, defs, forms);
  if (!calls?.length) return calls;
  const names = calls.map((call) => call.function.name).filter((name) => name !== TOOL_CALL_ERROR);
  if (names.length === 0) return calls;
  const offered = new Set(offeredToolNames);
  const unlisted = names.filter((name) => !offered.has(name));
  options.onTextToolCalls?.(names, unlisted);
  return calls;
}
