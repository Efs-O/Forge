/**
 * Keeps a chat's system prompt byte-identical when FORGE.md changes.
 *
 * FORGE.md is rendered into the system prompt, the head of the KV prefix. The
 * loader reloads it on every edit, so one edit used to rewrite the head of
 * every open chat and force a full re-read of each: on Strata, 2026-10-27, three
 * edits cost two 200K-token chats 46-115 s apiece (see
 * docs/reports/STRATA_FORGE_PERF_AUDIT_2026-10-27.md). Cloud providers bill
 * the same miss as uncached input.
 *
 * So each chat pins the text its system prompt was rendered with. A later
 * change reaches the model as a note in the turn context of the next turn's
 * opening message, which is appended at the tail and then frozen in place
 * (`freezeTurnContext`), so the prefix before it survives. The pin is renewed
 * only when compaction moves the window start: that request re-reads
 * everything after the system prompt anyway, and the note may have been
 * windowed out.
 */

import { z } from 'zod';

import type { ChatMessage } from '../llm/types';
import type { ConversationRuntime } from './sessionTypes';
import { compactionWindowStart } from './compactionWindow';
import { forgeInstructionsPinSchema } from './pinSchemas';

export type ForgeInstructionsPin = z.infer<typeof forgeInstructionsPinSchema>;

const NOTE_HEAD = '[FORGE.md changed during this chat]';

export interface PinnedTurnInstructions {
  /** What the system prompt renders as project instructions this turn. */
  system: string | undefined;
  /** Turn-context note, when the current text differs from what the model last saw. */
  note?: string;
}

/**
 * Called once per turn, before the turn context is frozen. Mutates `conv`'s
 * pin; the caller's normal persist writes it.
 */
export function pinForgeInstructions(
  conv: Pick<ConversationRuntime, 'messages' | 'compaction' | 'forgeInstructionsPin'>,
  current: string | undefined,
): PinnedTurnInstructions {
  const text = current ?? '';
  const windowStart = compactionWindowStart(conv.compaction);
  const pin = conv.forgeInstructionsPin;
  if (!pin || pin.windowStart !== windowStart) {
    conv.forgeInstructionsPin = { text, windowStart };
    return { system: text || undefined };
  }
  // Undo or a rewind can remove the message that carried the note.
  if (pin.announced && !carriesNote(conv.messages[pin.announced.messageIndex])) {
    delete pin.announced;
  }
  const seen = pin.announced?.text ?? pin.text;
  const system = pin.text || undefined;
  if (text === seen) return { system };

  if (text === pin.text) {
    delete pin.announced;
    return {
      system,
      note: `${NOTE_HEAD} It is back to the version in the system prompt's project instructions; the earlier FORGE.md update in this chat no longer applies.`,
    };
  }
  pin.announced = { text, messageIndex: turnOpeningIndex(conv.messages) };
  if (!text) {
    return {
      system,
      note: `${NOTE_HEAD} No FORGE.md applies any more; ignore the project instructions in the system prompt.`,
    };
  }
  return {
    system,
    note: `${NOTE_HEAD} This replaces the project instructions in the system prompt from now on:\n${text}`,
  };
}

function carriesNote(message: ChatMessage | undefined): boolean {
  return typeof message?.turnContext === 'string' && message.turnContext.includes(NOTE_HEAD);
}

/** The message `freezeTurnContext` will freeze this turn's block onto. */
function turnOpeningIndex(messages: readonly ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'user' && !message.midTurn) return i;
  }
  return -1;
}
