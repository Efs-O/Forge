import type { ChatMessage } from '../llm/types';
import type { PromptRunOptions } from './PromptRun';
import { COMPACTION_CHARS_PER_TOKEN, planOutput } from './compactionBudget';
import { CompactionFailure } from './compactionFailure';

const MAX_STAGE_CALLS = 24;
const MAX_STAGE_CHUNK_CHARS = 100_000;
const MAX_TOTAL_GENERATION_TOKENS = 400_000;
const SUMMARY_FRAME_CHARS = 400;
const PER_CHUNK_INDEX_CHARS = 90;
const REQUEST_MARGIN_TOKENS = 6_000;

export class StagedCompactionRefusal extends CompactionFailure {
  constructor(category: 'budget-refusal' | 'invalid-summary', message: string) {
    super(category, message);
    this.name = 'StagedCompactionRefusal';
  }
}

function refuse(
  message: string,
  category: 'budget-refusal' | 'invalid-summary' = 'budget-refusal',
): never {
  throw new StagedCompactionRefusal(category, message);
}

export interface StagedCompactionInput {
  messages: ChatMessage[];
  previousSummary?: string;
  pinnedFacts: string;
  originalRequest: string;
  exactPendingAction: string;
  modelName?: string;
  modelMaxTokens: number;
  outputLimitTokens: number;
  reasoningTokens: number;
  maximumSummaryChars: number;
  conversationId: string;
  runPrompt: (text: string, conversationId: string, options: PromptRunOptions) => Promise<string>;
}

export interface StagedCompactionResult {
  summary: string;
  calls: number;
  sourceChunks: number;
  requestedGenerationTokens: number;
}

function contentText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part !== 'object' || part === null) return '';
      if ('text' in part && typeof part.text === 'string') return part.text;
      if ('type' in part && part.type === 'image_url') return '[image attachment; payload omitted]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/** A bounded textual view of every message field relevant to conversation state. */
export function renderStagedSource(messages: ChatMessage[]): string {
  return messages
    .map((message, index) => {
      const content = contentText(message.content);
      const calls = message.tool_calls?.map(
        (call) => `${call.function.name}(${call.function.arguments})`,
      );
      const extras = [
        message.name ? `name=${message.name}` : '',
        message.tool_call_id ? `tool_call_id=${message.tool_call_id}` : '',
        calls?.length ? `tool_calls=${calls.join('\n')}` : '',
      ].filter(Boolean);
      return [`SOURCE MESSAGE ${index + 1} role=${message.role}`, content, ...extras]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
}

const IDENTIFIER_PATTERN = /[\w.-]+(?:[\\/][\w.-]+)+|[\w-]+\.[A-Za-z]{1,5}\b/gu;
const USER_REQUEST_PREFIX_CHARS = 160;

/** File/state identifiers named by the host's recorded facts; each must survive. */
export function requiredIdentifiers(pinnedFacts: string): string[] {
  return [...new Set(pinnedFacts.match(IDENTIFIER_PATTERN) ?? [])];
}

function userRequestManifest(messages: ChatMessage[]): string[] {
  return messages
    .filter((message) => message.role === 'user' && message.internal !== true)
    .map((message, i) => {
      const text = contentText(message.content).replace(/\s+/gu, ' ').trim();
      return `- User request ${i + 1}: ${
        text.length > USER_REQUEST_PREFIX_CHARS
          ? `${text.slice(0, USER_REQUEST_PREFIX_CHARS)}… [truncated]`
          : text
      }`;
    });
}

const REQUIRED_NOTE_HEADINGS = ['Goal', 'State', 'Next', 'Files', 'Constraints', 'Errors'] as const;

function missingRequiredHeadings(note: string): string[] {
  return REQUIRED_NOTE_HEADINGS.filter(
    (heading) =>
      !new RegExp(
        `^[ \\t]{0,3}(?:#{1,6}[ \\t]+)?(?:\\*\\*)?${heading}(?:\\*\\*)?(?:[ \\t]*:[^\\r\\n]*|[ \\t]*)$`,
        'imu',
      ).test(note),
  );
}

function sliceContiguous(source: string, chunkChars: number): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < source.length; ) {
    let end = Math.min(source.length, start + chunkChars);
    if (
      end < source.length &&
      end > start &&
      source.charCodeAt(end - 1) >= 0xd800 &&
      source.charCodeAt(end - 1) <= 0xdbff
    ) {
      end -= 1;
    }
    chunks.push(source.slice(start, end));
    start = end;
  }
  return chunks;
}

function extractionPrompt(
  context: string,
  index: number,
  count: number,
  chunk: string,
  noteChars: number,
): string {
  return [
    'Extract a compact but complete note from this exact source interval.',
    `HARD LIMIT: write between 200 and ${noteChars} characters total, including headings and newlines.`,
    'The character limit overrides requests for more detail. Use concise wording within each section.',
    'Do not infer that omitted context is unimportant. Preserve decisions, blockers, outcomes,',
    'file paths, identifiers, constraints, and the next action present in this interval.',
    'Use all six headings: Goal, State, Next, Files, Constraints, Errors. Write "none in this',
    'interval" when a heading has no evidence. Do not claim facts outside this interval.',
    `Chunk ${index + 1} of ${count}; source interval follows in order:`,
    context ? `Pinned context (interpretation only):\n${context}` : '',
    `SOURCE BEGIN\n${chunk}\nSOURCE END`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function makeChunks(
  source: string,
  input: StagedCompactionInput,
  pinnedContext: string,
): { chunks: string[]; noteChars: number; outputTokens: number; requestCap: number } {
  const slot = input.modelMaxTokens;
  if (slot <= 0) refuse('Staged compaction requires a configured per-conversation model slot.');
  let chunkChars = Math.min(MAX_STAGE_CHUNK_CHARS, Math.max(1_000, Math.floor(slot * 0.5)));

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const chunks = sliceContiguous(source, chunkChars);
    if (chunks.length > MAX_STAGE_CALLS) {
      refuse(
        `Staged compaction needs ${chunks.length} source chunks, above the ${MAX_STAGE_CALLS}-call limit; previous context kept.`,
      );
    }
    // The whole summary budget, less the pinned Goal/Next/index frame, split evenly.
    const frame =
      SUMMARY_FRAME_CHARS +
      input.originalRequest.length +
      input.exactPendingAction.length +
      requiredIdentifiers(input.pinnedFacts).join(', ').length +
      userRequestManifest(input.messages).join('\n').length +
      chunks.length * PER_CHUNK_INDEX_CHARS;
    const noteChars = Math.floor((input.maximumSummaryChars - frame) / chunks.length);
    if (noteChars < 400) {
      refuse(
        'Staged notes cannot preserve the required sections within the summary budget; previous context kept.',
      );
    }
    const plan = planOutput(
      Math.ceil(noteChars / COMPACTION_CHARS_PER_TOKEN),
      input.reasoningTokens,
      input.outputLimitTokens > 0 ? input.outputLimitTokens : slot,
    );
    if (!plan) {
      refuse(
        'The provider output limit leaves too little room for thinking plus a staged note; previous context kept.',
      );
    }
    const { outputTokens, requestCap } = plan;
    const largestChunk = Math.max(...chunks.map((chunk) => chunk.length));
    const promptChars = extractionPrompt(
      pinnedContext,
      chunks.length - 1,
      chunks.length,
      'x'.repeat(largestChunk),
      noteChars,
    ).length;
    const inputTokens = Math.ceil(promptChars / COMPACTION_CHARS_PER_TOKEN);
    // requestCap already contains the reasoning reserve; count it once.
    if (inputTokens + requestCap + REQUEST_MARGIN_TOKENS <= slot) {
      return { chunks, noteChars, outputTokens, requestCap };
    }
    chunkChars = Math.floor(chunkChars * 0.7);
  }
  refuse('Staged source chunks cannot fit the per-conversation slot; previous context kept.');
}

export async function summarizeInStages(
  input: StagedCompactionInput,
): Promise<StagedCompactionResult> {
  const source = renderStagedSource(input.messages);
  if (!source) refuse('Staged compaction has no source to cover; previous context kept.');
  if (!input.originalRequest || !input.exactPendingAction) {
    refuse(
      'Staged compaction cannot pin the original request and exact pending action; previous context kept.',
    );
  }
  const pinnedContext = [
    input.previousSummary ? `Previous summary:\n${input.previousSummary}` : '',
    input.pinnedFacts,
  ]
    .filter(Boolean)
    .join('\n\n');
  const { chunks, noteChars, outputTokens, requestCap } = makeChunks(source, input, pinnedContext);
  const requestedGenerationTokens = chunks.length * requestCap;
  if (requestedGenerationTokens > MAX_TOTAL_GENERATION_TOKENS) {
    refuse('Staged compaction exceeds its total generation-token bound; previous context kept.');
  }

  const notes: string[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (chunk === undefined) refuse('Staged compaction source interval is missing.');
    const note = await input.runPrompt(
      extractionPrompt(pinnedContext, index, chunks.length, chunk, noteChars),
      input.conversationId,
      {
        ...(input.modelName ? { modelName: input.modelName } : {}),
        systemPromptTemplate: 'summarize',
        outputTokens,
        strictOutputTokens: true,
        alwaysStripThinking: true,
        requireComplete: true,
      },
    );
    const trimmed = note.trim();
    if (trimmed.length > noteChars || trimmed.length < 200) {
      refuse(
        `Staged note ${index + 1}/${chunks.length} is incomplete or exceeds its ${noteChars}-character allocation; previous context kept.`,
        'invalid-summary',
      );
    }
    const missingHeadings = missingRequiredHeadings(trimmed);
    if (missingHeadings.length > 0) {
      refuse(
        `Staged note ${index + 1}/${chunks.length} lost required summary sections (${missingHeadings.join(', ')}); previous context kept.`,
        'invalid-summary',
      );
    }
    notes.push(trimmed);
  }

  const index = chunks
    .map(
      (_chunk, i) =>
        `- Chunk ${i + 1}/${chunks.length}: source offset ${chunks
          .slice(0, i)
          .reduce((total, part) => total + part.length, 0)}–${chunks
          .slice(0, i + 1)
          .reduce((total, part) => total + part.length, 0)}`,
    )
    .join('\n');
  const identifiers = requiredIdentifiers(input.pinnedFacts);
  const summary = [
    `Goal: ${input.originalRequest}`,
    `State:\n${notes.map((note, i) => `Chunk ${i + 1}:\n${note}`).join('\n\n')}`,
    `Next: ${input.exactPendingAction}`,
    `Files, Constraints, and Errors: see the ordered source notes; identifiers pinned below.`,
    `Pinned identifiers: ${identifiers.join(', ') || 'none recorded'}`,
    `User requests (in order):\n${userRequestManifest(input.messages).join('\n') || '- none'}`,
    `Cross-chunk index:\n${index}`,
  ].join('\n\n');
  const missing = identifiers.filter((id) => !summary.includes(id));
  if (missing.length > 0) {
    refuse(
      `Staged summary lost required identifiers (${missing.slice(0, 5).join(', ')}); previous context kept.`,
      'invalid-summary',
    );
  }
  if (summary.length > input.maximumSummaryChars) {
    refuse(
      `Staged summary needs ${summary.length} characters, above its ${input.maximumSummaryChars}-character allowance; previous context kept.`,
    );
  }
  return {
    summary,
    calls: chunks.length,
    sourceChunks: chunks.length,
    requestedGenerationTokens,
  };
}
