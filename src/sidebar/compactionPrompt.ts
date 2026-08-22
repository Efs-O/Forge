/**
 * Building the summarization request, and judging what comes back.
 *
 * Split out of `CompactionService.ts` for the file-size limit; that file owns
 * WHEN a compaction runs and what is done with the result, this one owns the
 * text going in and the text coming out. `compactionWindow.ts` owns applying a
 * recorded result at request time.
 */

import type { ChatMessage } from '../llm/types';

/** Cap a single tool result inside the summarization prompt. */
const TOOL_RESULT_MAX_CHARS = 2000;

export function truncateForSummary(text: string): string {
  return text.length <= TOOL_RESULT_MAX_CHARS
    ? text
    : `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n…[truncated for summary]`;
}

/** Keep the summary small enough to be useful, not a second transcript. */
export const COMPACTION_SUMMARY_MAX_CHARS = 5000;

/** Bound the input to the summarization turn as well as its output. */
const SUMMARY_SOURCE_MAX_CHARS = 24000;
const PREVIOUS_SUMMARY_MAX_CHARS = COMPACTION_SUMMARY_MAX_CHARS;
const MESSAGE_TEXT_MAX_CHARS = 3000;
const TOOL_CALL_METADATA_MAX_CHARS = 1200;

function truncateText(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…[truncated]`;
}

function formatToolCalls(message: ChatMessage): string {
  if (!message.tool_calls?.length) return '';
  const details = message.tool_calls
    .map((call) => `${call.function.name}(${truncateText(call.function.arguments, 400)})`)
    .join(', ');
  return `\nTool calls: ${truncateText(details, TOOL_CALL_METADATA_MAX_CHARS)}`;
}

function formatSummaryMessage(message: ChatMessage): string {
  const content =
    typeof message.content === 'string'
      ? message.content
      : message.content === null
        ? '[no visible assistant text]'
        : '[non-text content]';
  const body =
    message.role === 'tool'
      ? truncateForSummary(content)
      : truncateText(content, MESSAGE_TEXT_MAX_CHARS);
  const reasoning = message.reasoning
    ? `\nReasoning note: ${truncateText(message.reasoning, 600)}`
    : '';
  return `${message.role.toUpperCase()}:\n${body}${formatToolCalls(message)}${reasoning}`;
}

function capSummarySource(source: string): string {
  if (source.length <= SUMMARY_SOURCE_MAX_CHARS) return source;
  const head = Math.floor(SUMMARY_SOURCE_MAX_CHARS * 0.35);
  const tail = SUMMARY_SOURCE_MAX_CHARS - head;
  return `${source.slice(0, head)}\n…[middle of compaction source omitted]…\n${source.slice(-tail)}`;
}

/** The goal, quoted rather than paraphrased. */
const ORIGINAL_REQUEST_MAX_CHARS = 1200;

/**
 * The user's opening message, pinned OUTSIDE the truncated transcript.
 *
 * It is the shortest and most valuable thing in a conversation and it sits at
 * the very front, where a head/tail slice is most likely to cut it. Placing it
 * outside `capSummarySource` makes losing it impossible rather than unlikely.
 */
function anchorRequest(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user' && typeof m.content === 'string');
  if (!first || typeof first.content !== 'string' || !first.content.trim()) return '';
  const quoted = truncateText(first.content.trim(), ORIGINAL_REQUEST_MAX_CHARS);
  return `ORIGINAL REQUEST (the user's own words, never drop this):\n${quoted}\n\n`;
}

export function buildSummaryPrompt(
  previousSummary: string | undefined,
  messages: ChatMessage[],
): string {
  const previous = previousSummary
    ? `EARLIER SUMMARY:\n${truncateText(previousSummary, PREVIOUS_SUMMARY_MAX_CHARS)}\n\n`
    : '';
  const transcript = capSummarySource(messages.map(formatSummaryMessage).join('\n\n'));
  return (
    // One name for one artifact, matching SUMMARY_PREAMBLE and RESUME_PROMPT.
    'Create a compact conversation summary for the same repository.\n\n' +
    'Use only facts present below. Keep it under 600 words. ' +
    'Use these labels: Goal, State, Next, Files, Constraints, Errors. ' +
    // Next is the one section RESUME_PROMPT points the next turn at, so it must
    // always exist. Telling the model to "omit empty sections" without this
    // exception produced a summary with no Next, and the resumed agent went
    // hunting for a section we had told it to leave out.
    'ALWAYS include Next: record the exact next action, or write ' +
    '"nothing pending - the task is complete" when there is none. ' +
    'Omit any OTHER section that would be empty. Do not retell the conversation.\n\n' +
    `${previous}${anchorRequest(messages)}Conversation:\n${transcript}`
  );
}

/**
 * Tools that MODIFY a file, and the argument keys that carry the path.
 *
 * Taken from the schemas in `src/tools/`, not guessed: `edit_file` spells it
 * `filepath` while everything else uses `path`, and missing that spelling
 * silently zeroed this list on a session with 106 edits in it.
 */
const WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'apply_line_edits',
  'append_file',
  'insert_code',
  'delete_file',
  'move_file',
  'format_file',
  'rename_symbol',
  'create_file',
]);
const PATH_KEYS = ['path', 'filepath', 'file_path', 'source', 'destination'];

/** Cap on the appended block, so recorded facts cannot crowd out the summary. */
const RECORDED_FILES_MAX = 24;

/**
 * Every file the agent actually changed, read straight off the tool calls.
 *
 * No model judgement is involved, so this cannot be forgotten, paraphrased or
 * hallucinated - and unlike the summary it is derived from ALL the summarized
 * messages, not from the truncated prompt. Measured on session 39c9bf42: two of
 * six changed files never reached the model because the source cap dropped
 * them, so no summarizer could have named them.
 */
export function collectWrittenFiles(messages: ChatMessage[]): string[] {
  const found = new Set<string>();
  for (const msg of messages) {
    for (const call of msg.tool_calls ?? []) {
      if (!WRITE_TOOLS.has(call.function.name)) continue;
      let args: unknown;
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        continue;
      }
      if (!args || typeof args !== 'object') continue;
      for (const key of PATH_KEYS) {
        const value = (args as Record<string, unknown>)[key];
        if (typeof value === 'string' && value.trim()) {
          found.add(value.trim().split('\\').join('/'));
        }
      }
    }
  }
  return [...found];
}

/** The recorded-files block, or '' when nothing was written. */
export function recordedFilesBlock(messages: ChatMessage[]): string {
  const files = collectWrittenFiles(messages);
  if (files.length === 0) return '';
  const shown = files.slice(0, RECORDED_FILES_MAX);
  const more = files.length > shown.length ? `\n- ...and ${files.length - shown.length} more` : '';
  const list = shown.map((f) => `- ${f}`).join('\n');
  return `\n\n**Files changed (recorded by Forge, not written by the model):**\n${list}${more}`;
}

export function capSummary(summary: string, reserve = 0): string {
  return truncateText(summary.trim(), Math.max(0, COMPACTION_SUMMARY_MAX_CHARS - reserve));
}

/**
 * Room for the summary itself, ON TOP of whatever the model reserves for
 * thinking. COMPACTION_SUMMARY_MAX_CHARS is ~1600 tokens at 3.1 chars/token;
 * the worst measured thinking run used 4060 of a 5120 ceiling.
 */
export const SUMMARY_OUTPUT_TOKENS = 2048;

/** Below this a "summary" cannot be one — the shortest measured good run was
 *  several thousand characters, the failures were 117 and 150. */
const MIN_PLAUSIBLE_SUMMARY_CHARS = 200;

const TOOL_CALL_SHAPED = /"(tool|arguments|tool_calls|function)"\s*:/;
/**
 * Non-JSON tool-call syntaxes. Qwen emits `<tool_call><function=name>` and a
 * 153-character instance of exactly this was found stored as an 817-message
 * conversation's entire working context. The length floor happened to catch
 * that one; two of them concatenated would have sailed through.
 */
const XML_TOOL_CALL_SHAPED = /<\/?tool_call>|<function=|<\|tool_call\|>/i;

const FENCED_JSON_ONLY = /^```(?:json)?\s*[[{][\s\S]*[\]}]\s*```$/;

/**
 * Is this candidate a summary at all?
 *
 * Measured failure: under the agent persona the model answered the
 * summarization request with `{ "tool": "read_file", "arguments": {...} }` —
 * 117 characters that `capSummary` accepted, and which would then have BEEN the
 * conversation's working context for every following turn. A bad summary is
 * recoverable; a summary that is a tool call is a silently poisoned window.
 */
export function isUsableSummary(candidate: string): boolean {
  const text = candidate.trim();
  if (text.length < MIN_PLAUSIBLE_SUMMARY_CHARS) return false;
  if (TOOL_CALL_SHAPED.test(text)) return false;
  if (XML_TOOL_CALL_SHAPED.test(text)) return false;
  if (FENCED_JSON_ONLY.test(text)) return false;
  try {
    JSON.parse(text);
    return false;
  } catch {
    return true;
  }
}
