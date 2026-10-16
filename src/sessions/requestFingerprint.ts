import { createHash } from 'crypto';
import { toWireRequest } from '../llm/OpenAIClient';
import type { ChatCompletionRequest } from '../llm/types';

/**
 * What a model request looked like at its head, as hashes and counts only.
 *
 * Strata keeps a root checkpoint at the end of the system prompt that it never
 * evicts, and renders the tool block before the system text. A request that
 * reuses 0 tokens right after a long reuse therefore changed its first ~16K
 * tokens, and these fields say which part did. They carry no message or tool
 * text, so the row is safe in every chat, private ones included.
 * See docs/plans/REQUEST_PREFIX_LOG_PLAN.md.
 */
export interface RequestFingerprint {
  toolsHash: string;
  toolsChars: number;
  systemHash: string;
  systemChars: number;
  paramsHash: string;
  /** One hash per wire message, in order; kept in memory, never logged. */
  messageHashes: readonly string[];
  roles: readonly string[];
}

/** Hears each model request's offered tool names and head, per conversation. */
export type RequestOfferedListener = (
  convId: string,
  names: readonly string[],
  fingerprint: RequestFingerprint,
) => void;

/** Fields that cannot reach the rendered prompt, or are logged on their own. */
const NOT_PARAMS = new Set([
  'messages',
  'tools',
  'stream',
  'stream_options',
  'max_tokens',
  'max_completion_tokens',
]);

function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

export function fingerprintRequest(request: ChatCompletionRequest): RequestFingerprint {
  // The body OpenAIClient serializes, so sidebar-only message fields never
  // read as a change.
  const wire = toWireRequest(request);
  const tools = JSON.stringify(wire.tools ?? []);
  const first = wire.messages[0];
  const system = first?.role === 'system' ? JSON.stringify(first.content) : '';
  const params = Object.fromEntries(
    Object.entries(wire)
      .filter(([key]) => !NOT_PARAMS.has(key))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return {
    toolsHash: shortHash(tools),
    toolsChars: tools.length,
    systemHash: shortHash(system),
    systemChars: system.length,
    paramsHash: shortHash(JSON.stringify(params)),
    messageHashes: wire.messages.map((m) => shortHash(JSON.stringify(m))),
    roles: wire.messages.map((m) => m.role),
  };
}

/**
 * The session-log row for `next`. `first_changed` is the first message that
 * differs from the previous request's; it is absent when the previous request
 * is an unchanged prefix (the normal append) or there is none in this run.
 */
export function requestPrefixRow(
  previous: RequestFingerprint | undefined,
  next: RequestFingerprint,
): Record<string, unknown> {
  let firstChanged: number | undefined;
  if (previous) {
    const shared = Math.min(previous.messageHashes.length, next.messageHashes.length);
    for (let i = 0; i < shared; i++) {
      if (previous.messageHashes[i] !== next.messageHashes[i]) {
        firstChanged = i;
        break;
      }
    }
    if (firstChanged === undefined && next.messageHashes.length < previous.messageHashes.length) {
      firstChanged = next.messageHashes.length;
    }
  }
  return {
    type: 'request_prefix',
    tools_hash: next.toolsHash,
    tools_chars: next.toolsChars,
    system_hash: next.systemHash,
    system_chars: next.systemChars,
    params_hash: next.paramsHash,
    messages: next.messageHashes.length,
    ...(firstChanged !== undefined
      ? { first_changed: firstChanged, changed_role: next.roles[firstChanged] ?? 'removed' }
      : {}),
  };
}
