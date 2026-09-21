import type { ChatMessage, ToolCall } from '../llm/types';

interface ToolRoundRecord {
  call: string;
  result: string;
}

interface FailedToolStreak {
  tool: string;
  path: string;
  count: number;
}

/** Read-only investigation can legitimately repeat a search while auditing. */
const IDENTICAL_READ_ONLY_ROUNDS = 6;
const ALTERNATING_READ_ONLY_ROUNDS = 10;

export class ToolLoopDetectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolLoopDetectedError';
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function canonicalArguments(raw: string): string {
  try {
    return JSON.stringify(canonicalize(JSON.parse(raw)));
  } catch {
    return raw.trim();
  }
}

function callFingerprint(calls: ToolCall[]): string {
  return calls
    .map((call) => `${call.function.name}:${canonicalArguments(call.function.arguments)}`)
    .join('|');
}

function resultFingerprint(messages: ChatMessage[]): string {
  return messages
    .filter((message) => message.role === 'tool')
    .map((message) => `${message.name ?? ''}:${String(message.content ?? '')}`)
    .join('|');
}

/** Detects exact and alternating no-progress tool cycles across completion rounds. */
export class ToolLoopGuard {
  private readonly records: ToolRoundRecord[] = [];
  private failedToolStreak: FailedToolStreak | undefined;

  beforeRound(calls: ToolCall[], isMutatingTool?: (name: string) => boolean): void {
    if (!calls.some((call) => isMutatingTool?.(call.function.name))) return;
    const call = callFingerprint(calls);
    const length = this.records.length;
    if (
      length >= 2 &&
      this.records[length - 1]?.call === call &&
      this.records[length - 2]?.call === call
    ) {
      throw new ToolLoopDetectedError(
        'Forge: repeated mutating tool call blocked before a third execution.',
      );
    }
  }

  afterRound(
    calls: ToolCall[],
    resultMessages: ChatMessage[],
    isMutatingTool?: (name: string) => boolean,
  ): boolean {
    this.records.push({ call: callFingerprint(calls), result: resultFingerprint(resultMessages) });
    const failure = this.warnOnRepeatedFailure(calls, resultMessages);
    if (failure.tracked) return failure.warned;
    const length = this.records.length;
    const last = this.records[length - 1];
    if (
      length >= IDENTICAL_READ_ONLY_ROUNDS &&
      this.records
        .slice(-IDENTICAL_READ_ONLY_ROUNDS)
        .every((record) => record.call === last?.call && record.result === last?.result)
    ) {
      throw new ToolLoopDetectedError('Forge: repeated tool call produced no progress.');
    }
    if (length >= ALTERNATING_READ_ONLY_ROUNDS) {
      const cycle = this.records.slice(-ALTERNATING_READ_ONLY_ROUNDS);
      const left = cycle[0];
      const right = cycle[1];
      if (
        left &&
        right &&
        cycle.every((record, index) => {
          const expected = index % 2 === 0 ? left : right;
          return record.call === expected.call && record.result === expected.result;
        })
      ) {
        throw new ToolLoopDetectedError('Forge: alternating tool-call cycle produced no progress.');
      }
    }

    if (calls.some((call) => isMutatingTool?.(call.function.name))) return false;
    const earlier = this.records.findIndex(
      (record, index) =>
        index < length - 1 && record.call === last?.call && record.result === last?.result,
    );
    if (earlier < 0) return false;
    const prefix =
      `[Forge warning: this read-only tool call and result repeat round ${earlier + 1}. ` +
      'Act on the result you already have or change approach.]\n';
    for (const message of resultMessages) {
      if (message.role !== 'tool' || typeof message.content !== 'string') continue;
      message.content = `${prefix}${message.content}`;
    }
    return true;
  }

  private warnOnRepeatedFailure(
    calls: ToolCall[],
    resultMessages: ChatMessage[],
  ): { tracked: boolean; warned: boolean } {
    const toolResults = resultMessages.filter(
      (message) => message.role === 'tool' && typeof message.content === 'string',
    );
    let tracked = false;
    let warned = false;
    for (const [index, call] of calls.entries()) {
      const result =
        toolResults.find((message) => message.tool_call_id === call.id) ?? toolResults[index];
      const path = this.pathArgument(call);
      if (
        !result ||
        path === undefined ||
        typeof result.content !== 'string' ||
        !result.content.startsWith('Error:')
      ) {
        this.failedToolStreak = undefined;
        continue;
      }
      tracked = true;
      const previous = this.failedToolStreak;
      const count =
        previous?.tool === call.function.name && previous.path === path ? previous.count + 1 : 1;
      this.failedToolStreak = { tool: call.function.name, path, count };
      if (count < 3) continue;
      result.content =
        `[Forge warning: ${count} failed ${call.function.name} calls in a row on ${path}. ` +
        'Read the error: it says what is wrong. Change the arguments or stop.]\n' +
        result.content;
      warned = true;
    }
    return { tracked, warned };
  }

  private pathArgument(call: ToolCall): string | undefined {
    try {
      const args: unknown = JSON.parse(call.function.arguments);
      if (
        args &&
        typeof args === 'object' &&
        typeof (args as { path?: unknown }).path === 'string'
      ) {
        return (args as { path: string }).path;
      }
    } catch {
      // Invalid arguments cannot identify a path, so they are not part of this streak.
    }
    return undefined;
  }
}
