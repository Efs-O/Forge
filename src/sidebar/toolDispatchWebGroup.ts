import type { ToolCall } from '../llm/types';
import { isJsonObject, parseJson } from '../tools/jsonInput';
import { normalizedHostname } from '../tools/fetchHostApprovals';

const MAX_PARALLEL_WEB_FETCHES = 3;

/**
 * Build one run of consecutive `web_fetch` calls, with one request per host.
 * The caller has resolved the current call's alias before calling this helper.
 * A malformed URL is returned alone so the fetch handler can report its error.
 */
export function buildWebFetchGroup(
  calls: readonly ToolCall[],
  startIndex: number,
): readonly ToolCall[] {
  const first = calls[startIndex];
  if (!first || first.function.name !== 'web_fetch') return [];

  const firstHost = fetchHostname(first);
  if (firstHost === undefined) return [first];

  const group = [first];
  const hosts = new Set([firstHost]);
  for (
    let index = startIndex + 1;
    index < calls.length && group.length < MAX_PARALLEL_WEB_FETCHES;
    index += 1
  ) {
    const candidate = calls[index]!;
    if (candidate.function.name !== 'web_fetch') break;
    const host = fetchHostname(candidate);
    if (host === undefined || hosts.has(host)) break;
    group.push(candidate);
    hosts.add(host);
  }
  return group;
}

function fetchHostname(call: ToolCall): string | undefined {
  const parsed = parseJson(call.function.arguments);
  if (!parsed.ok || !isJsonObject(parsed.value)) return undefined;
  const rawUrl = parsed.value['url'];
  if (typeof rawUrl !== 'string') return undefined;
  try {
    return normalizedHostname(new URL(rawUrl));
  } catch {
    return undefined;
  }
}
