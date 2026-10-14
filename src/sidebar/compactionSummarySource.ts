/**
 * The transcript the summarizer reads: each message formatted, then the whole
 * cut to the source budget.
 *
 * Split out of `compactionPrompt.ts`, which assembles the request around this
 * transcript. Cutting sheds detail in a fixed order before it refuses, and
 * every step that ran leaves a `[for space: …]` line at the head, so the
 * summarizer knows what it is not seeing.
 */

import type { ChatMessage } from '../llm/types';
import { CompactionFailure } from './compactionFailure';
import { textWithImageNotes } from './imageParts';

/** Small direct-call defaults; the service supplies percentage budgets. */
const TOOL_RESULT_MAX_CHARS = 2000;

const TOOL_CALL_METADATA_MAX_CHARS = 1200;

export function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = '\n…[middle omitted]…\n';
  const room = Math.max(0, limit - marker.length);
  const head = Math.ceil(room / 2);
  return `${text.slice(0, head)}${marker}${text.slice(-(room - head))}`;
}

/** Bound re-fetchable tool output while retaining its start and final status. */
function compactToolOutput(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = '\n…[middle omitted; retrieve exact evidence with read_tool_result]…\n';
  const room = limit - marker.length;
  const head = Math.ceil(room * 0.6);
  return `${text.slice(0, head)}${marker}${text.slice(-Math.floor(room * 0.4))}`;
}

type ToolCallDetailMode = 'full' | 'names' | 'none';

interface SummaryMessageFormatOptions {
  reasoning?: boolean;
  toolCalls?: ToolCallDetailMode;
  contentLimit?: { side: 'start' | 'end'; chars: number };
  drop?: boolean;
}

function clampKeepingEnding(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = '…[earlier text omitted]';
  return `${marker}${text.slice(-(limit - marker.length))}`;
}

function formatToolCalls(message: ChatMessage, mode: ToolCallDetailMode = 'full'): string {
  if (!message.tool_calls?.length) return '';
  if (mode === 'none') return '';
  const details = message.tool_calls
    .map((call) =>
      mode === 'names'
        ? call.function.name
        : `${call.function.name}(${truncateText(call.function.arguments, 400)})`,
    )
    .join(', ');
  return `\nTool calls: ${truncateText(details, TOOL_CALL_METADATA_MAX_CHARS)}`;
}

function formatSummaryMessage(
  message: ChatMessage,
  sourceMaxChars: number,
  options: SummaryMessageFormatOptions = {},
): string {
  if (options.drop) return '';
  let content =
    typeof message.content === 'string'
      ? message.content
      : message.content === null
        ? '[no visible assistant text]'
        : textWithImageNotes(message, {
            reason: 'summarized',
            textAttachments: { maxChars: 2000 },
          });
  if (options.contentLimit) {
    content =
      options.contentLimit.side === 'end'
        ? clampKeepingEnding(content, options.contentLimit.chars)
        : content.slice(0, options.contentLimit.chars);
  }
  const body =
    message.role === 'tool'
      ? compactToolOutput(
          content,
          Math.max(TOOL_RESULT_MAX_CHARS, Math.floor(sourceMaxChars * 0.015)),
        )
      : content;
  const reasoning =
    options.reasoning === false
      ? ''
      : message.reasoning
        ? `\nReasoning note: ${truncateText(message.reasoning, 600)}`
        : '';
  return `${message.role.toUpperCase()}:\n${body}${formatToolCalls(message, options.toolCalls)}${reasoning}`;
}

interface ToolResultOmission {
  readonly kept: Set<number>;
  readonly render: (entries: readonly string[]) => string;
}

function toolResultOmission(
  formatted: readonly string[],
  messages: readonly ChatMessage[],
  maxChars: number,
): ToolResultOmission {
  const toolIndexes = formatted
    .map((_, index) => index)
    .filter((index) => messages[index]?.role === 'tool');
  const kept = new Set<number>();
  const omittedMarker = (count: number): string =>
    `…[${count} tool result${count === 1 ? '' : 's'} omitted for space; retrieve exact evidence with read_tool_result if needed]…`;
  const render = (entries: readonly string[]): string => {
    const selected: string[] = [];
    let inGap = false;
    for (let index = 0; index < entries.length; index += 1) {
      if (messages[index]?.role !== 'tool' || kept.has(index)) {
        if (entries[index]) selected.push(entries[index]!);
      } else if (!inGap) {
        selected.push(omittedMarker(toolIndexes.length - kept.size));
        inGap = true;
      }
    }
    return selected.join('\n\n');
  };

  // Preserve the old preference: recent tool evidence is considered first,
  // with the opening 30% considered after it.
  const headCount = Math.floor(toolIndexes.length * 0.3);
  const priority = [...toolIndexes.slice(headCount).reverse(), ...toolIndexes.slice(0, headCount)];
  for (const index of priority) {
    kept.add(index);
    if (render(formatted).length > maxChars) kept.delete(index);
  }
  return { kept, render };
}

function sourceWithHeadLines(lines: readonly string[], transcript: string): string {
  return lines.length ? `${lines.join('\n')}\n\n${transcript}` : transcript;
}

/**
 * Cut the summarization source to whole messages, keeping the most recent.
 *
 * A raw character slice cut mid-message, so a completion report or a decision
 * could reach the summarizer as half a sentence — and the middle of a long
 * investigation, where the conclusions are, vanished with no trace that
 * anything had been dropped. Whole messages from each end, and an explicit
 * count of what was removed, is the same bound with a legible result.
 *
 * The recency bias is deliberate: the opening is separately pinned by
 * `anchorRequest`, so the newest exchanges are the ones that exist only here.
 */
function capSummarySource(
  formatted: readonly string[],
  messages: readonly ChatMessage[],
  maxChars: number,
  upFront = false,
): string {
  const joined = formatted.join('\n\n');
  if (!upFront && joined.length <= maxChars) return joined;

  const toolResults = toolResultOmission(formatted, messages, maxChars);
  const optionsByIndex = new Map<number, SummaryMessageFormatOptions>();
  const earlier = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role !== 'tool');
  const older = earlier.slice(0, Math.max(0, earlier.length - 6));
  const newest = earlier.slice(-6);
  const lines: string[] = [];
  const render = (): string => {
    const entries = formatted.map((entry, index) => {
      if (messages[index]?.role === 'tool') return entry;
      return formatSummaryMessage(messages[index]!, maxChars, optionsByIndex.get(index));
    });
    return sourceWithHeadLines(lines, toolResults.render(entries));
  };

  // Floor mode (the one retry after a budget refusal) runs steps 1-4 in full.
  let shedAll = upFront;
  const fits = (): boolean => !shedAll && render().length <= maxChars;
  if (fits()) return render();

  const shedOlderEntries = (
    entries: readonly { message: ChatMessage; index: number }[],
    changed: (message: ChatMessage, options: SummaryMessageFormatOptions) => boolean,
    apply: (
      message: ChatMessage,
      options: SummaryMessageFormatOptions,
    ) => SummaryMessageFormatOptions,
    headline: (count: number) => string,
  ): boolean => {
    let affected = 0;
    let lineIndex = -1;
    let renderedLength = render().length;
    for (const { message, index } of entries) {
      const beforeOptions = optionsByIndex.get(index) ?? {};
      if (!changed(message, beforeOptions)) continue;
      const before = formatSummaryMessage(message, maxChars, beforeOptions);
      const afterOptions = apply(message, beforeOptions);
      const after = formatSummaryMessage(message, maxChars, afterOptions);
      if (before === after) continue;
      optionsByIndex.set(index, afterOptions);
      renderedLength += after.length - before.length;
      affected += 1;
      if (lineIndex < 0) {
        lineIndex = lines.length;
        lines.push(headline(affected));
        renderedLength += lines[lineIndex]!.length + 2;
      } else {
        const oldLine = lines[lineIndex]!;
        lines[lineIndex] = headline(affected);
        renderedLength += lines[lineIndex]!.length - oldLine.length;
      }
      if (renderedLength <= maxChars && fits()) return true;
    }
    return affected > 0;
  };

  shedOlderEntries(
    older,
    (message, options) => Boolean(message.reasoning) && options.reasoning !== false,
    (_message, options) => ({ ...options, reasoning: false }),
    (count) => `[for space: reasoning notes dropped from ${count} earlier entries]`,
  );
  if (fits()) return render();

  shedOlderEntries(
    older,
    (message, options) =>
      Boolean(message.tool_calls?.length) &&
      options.toolCalls !== 'names' &&
      options.toolCalls !== 'none',
    (_message, options) => ({ ...options, toolCalls: 'names' }),
    (count) => `[for space: tool-call details reduced to names in ${count} earlier entries]`,
  );
  if (fits()) return render();

  shedOlderEntries(
    older.filter(({ message }) => message.role === 'assistant'),
    (message, options) => message.role === 'assistant' && options.contentLimit?.chars !== 600,
    (_message, options) => ({ ...options, contentLimit: { side: 'end', chars: 600 } }),
    (count) => `[for space: earlier assistant entries cut to their last 600 chars (${count})]`,
  );
  if (fits()) return render();

  shedOlderEntries(
    older.filter(({ message }) => message.role === 'user'),
    (message, options) => message.role === 'user' && options.contentLimit?.chars !== 1000,
    (_message, options) => ({ ...options, contentLimit: { side: 'start', chars: 1000 } }),
    (count) => `[for space: earlier user entries cut to their first 1,000 chars (${count})]`,
  );
  // Floor mode applied steps 1-4 to every older entry; from here, stop once it fits.
  shedAll = false;
  if (fits()) return render();

  const oldAssistants = older.filter(({ message }) => message.role === 'assistant');
  if (oldAssistants.length) {
    let dropped = 0;
    const lineIndex = lines.length;
    lines.push('[for space: 1 earlier assistant entry dropped]');
    // Estimate as entries go, like shedOlderEntries: a full render per drop
    // is quadratic in a long conversation. Confirm with a render once it fits.
    let renderedLength = render().length;
    for (const { message, index } of oldAssistants) {
      // A dropped entry renders empty and loses its '\n\n' separator too.
      renderedLength -=
        formatSummaryMessage(message, maxChars, optionsByIndex.get(index)).length + 2;
      optionsByIndex.set(index, { drop: true });
      dropped += 1;
      lines[lineIndex] =
        `[for space: ${dropped} earlier assistant entr${dropped === 1 ? 'y' : 'ies'} dropped]`;
      if (renderedLength <= maxChars && fits()) return render();
    }
  }
  if (fits()) return render();

  const newestAffected = newest.filter(({ message, index }) => {
    const options = optionsByIndex.get(index) ?? {};
    return (
      (message.role === 'assistant' && options.contentLimit?.chars !== 1500) ||
      (message.role === 'user' && options.contentLimit?.chars !== 1500) ||
      (Boolean(message.reasoning) && options.reasoning !== false) ||
      (Boolean(message.tool_calls?.length) && options.toolCalls !== 'none')
    );
  });
  for (const { message, index } of newestAffected) {
    optionsByIndex.set(index, {
      ...(optionsByIndex.get(index) ?? {}),
      reasoning: false,
      toolCalls: 'none',
      contentLimit: {
        side: message.role === 'assistant' ? 'end' : 'start',
        chars: 1500,
      },
    });
  }
  if (newestAffected.length) {
    lines.push(
      `[for space: newest six entries reduced (${newestAffected.length} affected); entries capped at 1,500 chars, reasoning and tool-call details dropped]`,
    );
  }
  const source = render();
  if (source.length <= maxChars) return source;
  throw new CompactionFailure(
    'budget-refusal',
    `The conversation's user requests and assistant replies alone need at least ${source.length} characters ` +
      'after applying the source-shedding floor ' +
      `(floor: ${source.length} characters), above the ${maxChars}-character budget; previous context kept. ` +
      'Start a new chat, or use a model with a larger context window.',
  );
}

/**
 * The formatted, budget-fitted transcript for `buildSummaryPrompt`. `floorMode`
 * applies shed steps 1-4 to every older entry before checking the fit.
 */
export function summarySource(
  messages: readonly ChatMessage[],
  sourceMaxChars: number,
  floorMode = false,
): string {
  return capSummarySource(
    messages.map((message) => formatSummaryMessage(message, sourceMaxChars)),
    messages,
    sourceMaxChars,
    floorMode,
  );
}
