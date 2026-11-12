/** Checks that decide a tool call never runs, before approval. */
import type { ToolCall } from '../llm/types';
import type { ToolBudget } from '../tools/ToolBudget';
import type { RegisteredTool, ToolHandlerResult, ToolPermission } from '../tools/ToolRegistry';
import type { ToolRegistry } from '../tools/ToolRegistry';
import { unknownToolResult } from './retiredTools';

/** Suggests a correction that matches the JSON parser's reported failure. */
export function invalidJsonAdvice(raw: string, parserMessage: string): string {
  const markupTokens = [
    '</parameter',
    '</function',
    '</tool_call',
    '<parameter=',
    '<function=',
    '<tool_call>',
  ];
  if (
    parserMessage.startsWith('Unterminated string') ||
    parserMessage === 'Unexpected end of JSON input'
  ) {
    const token = markupTokens
      .map((candidate) => ({ candidate, index: raw.indexOf(candidate) }))
      .filter(({ index }) => index >= 0)
      .sort((a, b) => a.index - b.index)[0];
    if (token) {
      const beforeToken = raw.slice(0, token.index);
      const fields = [...beforeToken.matchAll(/"([A-Za-z0-9_-]+)":"/gu)];
      const field = fields.at(-1)?.[1];
      return field
        ? `Tool-call markup (${token.candidate}) ended up inside the string value of "${field}", which was never closed. Close the value with " and the object with }, and keep tool-call markup out of the arguments, then resend.`
        : `Tool-call markup (${token.candidate}) ended up inside a string value that was never closed. Close the value with " and the object with }, and keep tool-call markup out of the arguments, then resend.`;
    }
  }
  if (
    parserMessage.startsWith('Bad escaped character') ||
    parserMessage.startsWith('Bad Unicode escape')
  ) {
    return 'Write each literal backslash as \\\\ and resend.';
  }
  if (parserMessage.startsWith('Bad control character')) {
    return 'Write each newline inside a string as \\n and each tab as \\t, then resend.';
  }
  return 'Resend the arguments as one complete JSON object.';
}

/**
 * A tool-call argument value that holds a whole parameter block: the engine's
 * tool-call parser folded a second `<parameter=NAME>` block into this value
 * instead of ending the call, so what reached the tool is not what was meant.
 *
 * Only positional shapes are matched. A lone markup token inside a value is
 * usually content the model was asked to write — Forge's own sources quote
 * these tags — so a bare substring test would refuse legitimate edits. Every
 * shape here is one a value only takes by leaking: a closing tag immediately
 * followed by an opening one, a value that begins with an opening tag, a value
 * that ends on a closing tag while holding an opening one, or a newline-then
 * opening tag naming one of this tool's own parameters.
 */
export function markupLeakInArgs(
  name: string,
  args: Record<string, unknown>,
  paramNames: readonly string[],
): string | undefined {
  const values: { path: string; value: string }[] = [];
  collectStringValues(args, '', values);
  for (const entry of values) {
    if (!isLeakedMarkupValue(entry.value, paramNames)) continue;
    return (
      `Error: ${name}: tool-call markup ended up inside the value of "${entry.path}" — ` +
      `it reads "…${excerpt(entry.value)}". The engine's parser folded a second parameter block ` +
      'into this value, so the arguments that reached the tool are not what was meant. Resend ' +
      'the call with one parameter block per argument and no markup inside any value.'
    );
  }
  return undefined;
}

function collectStringValues(
  value: unknown,
  path: string,
  out: { path: string; value: string }[],
): void {
  if (typeof value === 'string') {
    out.push({ path, value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStringValues(item, `${path}[${index}]`, out));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      collectStringValues(item, path ? `${path}.${key}` : key, out);
    }
  }
}

function isLeakedMarkupValue(raw: string, paramNames: readonly string[]): boolean {
  const value = raw.replace(/\r\n/gu, '\n');
  if (value.includes('</parameter>\n<parameter=')) return true;
  if (value.trimStart().startsWith('<parameter=')) return true;
  if (value.trimEnd().endsWith('</parameter>') && value.includes('<parameter=')) return true;
  return paramNames.some((param) => value.includes(`\n<parameter=${param}>`));
}

/** The tail of the value from where its first markup tag begins, on one line. */
function excerpt(value: string): string {
  const index = value.search(/<[/?]?parameter/u);
  const from = index < 0 ? 0 : Math.max(0, index - 40);
  const tail = value.slice(from).replace(/\s+/gu, ' ');
  return tail.length > 120 ? tail.slice(-120) : tail;
}

/** The parameter names of one registered tool, for the leak shapes that need them. */
function parameterNames(reg: RegisteredTool): readonly string[] {
  const schema = reg.definition.function.parameters as unknown as {
    properties?: Record<string, unknown>;
  };
  return Object.keys(schema?.properties ?? {});
}

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
      invalidJsonAdvice(tc.function.arguments, parserMessage);
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
  // Valid JSON, but the engine's parser folded a second parameter block into one
  // of the values, so running this call would act on text the model never meant
  // as an argument — an edit would write the markup straight into the file.
  const leaked = markupLeakInArgs(tc.function.name, args, parameterNames(reg));
  if (leaked) {
    return { kind: 'refused', result: leaked, recordFailure: true };
  }
  const budgetBlock = input.budget?.check(tc.function.name);
  if (budgetBlock) {
    return { kind: 'refused', result: budgetBlock, recordFailure: false };
  }

  return { kind: 'ready', args, reg };
}
