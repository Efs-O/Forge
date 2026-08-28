/**
 * Single owner for inspecting and replacing `image_url` content parts.
 *
 * Images leave a conversation for three unrelated reasons, and the note left
 * behind must say which one — a model told "the image is gone" when the image is
 * in fact still in the transcript will contradict what the user can see, and a
 * model told nothing at all will confabulate a description that nothing can
 * refute. Every replacement in Forge goes through `stripImageParts` so the three
 * cases cannot drift apart.
 */

import type { ChatMessage, ContentPart } from '../llm/types';

/** Image parts never reach workspaceState, so a restored turn must say so. */
export const TOOL_IMAGE_DROPPED_NOTE =
  '[The image itself was not retained across the reload and is NOT visible to you now. ' +
  'Call view_image again before describing it.]';
export const USER_IMAGE_DROPPED_NOTE =
  '[The user attached an image here. It was not retained across the reload and is NOT ' +
  'visible to you now. Ask the user to re-attach it before describing it.]';

/**
 * Why the image is not in the message any more.
 *
 * - `persist`   the pixels are genuinely gone (never written to workspaceState).
 * - `no-vision` the image still exists in the transcript; the ACTIVE model just
 *               has no projector. Needs the model name to be actionable.
 * - `aged-out`  dropped from the model-facing copy to reclaim context. It is
 *               recoverable — say how.
 */
export type ImageStripOptions =
  | { reason: 'persist' }
  | { reason: 'no-vision'; modelName: string }
  | { reason: 'aged-out' };

/**
 * The "do not guess" clause in every note is load-bearing: a local model handed
 * a bare gap will invent a description, and the pixels are no longer there to
 * contradict it.
 */
function noteFor(options: ImageStripOptions, role: ChatMessage['role']): string {
  switch (options.reason) {
    case 'persist':
      return role === 'tool' ? TOOL_IMAGE_DROPPED_NOTE : USER_IMAGE_DROPPED_NOTE;
    case 'no-vision':
      return (
        `[An image was attached here. The active model "${options.modelName}" has no vision ` +
        'projector, so it cannot see it. Switch to a vision-capable model to view it — ' +
        'do not describe or guess at its contents.]'
      );
    case 'aged-out':
      return role === 'tool'
        ? '[An image from an earlier view_image call is no longer in context. Call ' +
            'view_image again if you need to look at it — do not describe or guess at ' +
            'its contents.]'
        : '[An image the user attached earlier is no longer in context. Ask the user to ' +
            're-attach it if you need to look at it — do not describe or guess at its ' +
            'contents.]';
  }
}

export function hasImageParts(content: ChatMessage['content']): boolean {
  return Array.isArray(content) && content.some((part) => part.type === 'image_url');
}

/** How many `image_url` parts the transcript carries, across every message. */
export function countImageParts(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === 'image_url') total += 1;
    }
  }
  return total;
}

function replaceIn(content: ContentPart[], options: ImageStripOptions, role: ChatMessage['role']) {
  return content.map((part) =>
    part.type === 'image_url' ? { type: 'text' as const, text: noteFor(options, role) } : part,
  );
}

/**
 * Replace every `image_url` part with a note saying why it is not there,
 * preserving sibling text parts and message order.
 *
 * Returns the SAME array reference when nothing changed, and clones only the
 * messages whose content actually differs — `prepareMessages` runs this on every
 * tool round over transcripts that are almost never image-bearing.
 */
export function stripImageParts(
  messages: ChatMessage[],
  options: ImageStripOptions,
): ChatMessage[] {
  if (!messages.some((message) => hasImageParts(message.content))) return messages;
  return messages.map((message) =>
    Array.isArray(message.content) && hasImageParts(message.content)
      ? { ...message, content: replaceIn(message.content, options, message.role) }
      : message,
  );
}

/**
 * Drop images the conversation has moved past, keeping the recent ones.
 *
 * Retention counts **subsequent user messages**, not assistant/tool protocol
 * messages: a tool-heavy round would otherwise evict an image the user attached
 * one prompt ago. `0` keeps an image for the whole user turn that introduced it
 * and removes it on the next user prompt, so the newest image is never removed
 * from the turn in which it arrived.
 *
 * `undefined` retention means the feature is off — today's behaviour, and the
 * default. There is no implicit numeric fallback.
 */
export function ageOutImageParts(
  messages: ChatMessage[],
  retentionUserTurns: number | undefined,
): ChatMessage[] {
  if (retentionUserTurns === undefined) return messages;
  let laterUserMessages = 0;
  const agedIndexes = new Set<number>();
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message === undefined) continue;
    if (hasImageParts(message.content) && laterUserMessages > retentionUserTurns) {
      agedIndexes.add(i);
    }
    if (message.role === 'user') laterUserMessages += 1;
  }
  if (agedIndexes.size === 0) return messages;
  return messages.map((message, index) =>
    agedIndexes.has(index) && Array.isArray(message.content)
      ? { ...message, content: replaceIn(message.content, { reason: 'aged-out' }, message.role) }
      : message,
  );
}
