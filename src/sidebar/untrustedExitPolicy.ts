/**
 * The card rule that replaces "every write asks the owner".
 *
 * Before phase 4, a card opened for any call holding a write, terminal, headless
 * or git-write permission, so a chat that only wanted to run a build paid for
 * every `touch`, `mkdir` and `npm run build` it asked for. The weekend sweep over
 * the session logs (`docs/reports/security-sweep-2026-11-02/`) could not count a
 * single one of those cards, because nothing recorded them — which is why phase 1
 * added `gateEventLog.ts` first and this rule second: the removals are ordered by
 * measured cost, and the cost is now being measured.
 *
 * What a card is FOR, restated: content that did not come from the owner. Two
 * ways that arrives — this chat read a secret file, or this chat took in a page,
 * a search answer, a browser snapshot or a reply from an MCP server. Either one
 * means the model may be acting on text it was handed rather than text the owner
 * chose, so anything this chat sends out afterwards needs an owner in the loop.
 * A chat with neither has nothing in it that an outside page could have steered:
 * its shell, edits, builds and reads run with no card, because the only thing
 * they could send out is the workspace the owner already owns.
 *
 * This module computes which calls need a candidate card. The chat approval layer
 * then applies Clanker's three-stop rule: deny-list and owner-only refusals stay,
 * and secret-tainted egress stays owner-gated; other dangerous, tool-specific,
 * outside-workspace, or content-tainted candidates may be answered by Clanker.
 * Chats with Clanker off and unattended runs retain their existing paths.
 */
import { SECRET_TAINT_REFUSAL_REASON } from './toolApprovalOutcome';
import { hasConversationReadSecret, hasConversationReadUntrusted } from '../tools/exfilTaint';

/** Which way a call leaves this machine. `none` is the common case, and the
 *  default: a tool that does not declare an exit does not have one. */
export type ExitKind = 'none' | 'network' | 'cross_chat' | 'delegation';

/** One entry per way out, so the card and the refusal name the door rather than
 *  saying "policy", which is the answer the agent cannot act on. */
export const EXIT_LABELS: Record<Exclude<ExitKind, 'none'>, string> = {
  network: 'sends bytes to another host',
  cross_chat: 'hands this message to a different chat',
  delegation: 'gives this task, and the text in it, to another model',
};

/** What the flag is called in the card, in the words the owner reads. */
const FLAG_LABELS = {
  content: 'outside content (a page, a search result or an MCP reply)',
  secret: 'a secret file',
} as const;

export type FlaggedBy = 'content' | 'secret';

export interface UntrustedExitInput {
  toolName: string;
  /** The tool's own gate called this dangerous: a deny-list rule, a permanent
   *  delete, a new host or origin, a secret path, the exfil gates. */
  dangerous: boolean;
  /** The tool's own gate wants the owner to see this call. It is `true` when the
   *  tool returned approval metadata that is not `cardTextOnly` — metadata that
   *  is only the card's text (a `normal` shell command's cwd lines) is not a gate. */
  toolGate: boolean;
  /** A mutation whose paths land outside the workspace: `extra_file_roots` made it
   *  allowed, not ordinary, and the plan keeps its card in every chat. */
  outsideWorkspace: boolean;
  /** Which way this call leaves the machine, from the gate that knows. */
  reachesOut: ExitKind;
  /** True when the tool declared itself structurally bounded enough to run
   *  unconfirmed (`autoApprove` / `autoApproveIf`): the owner approved THAT tool by
   *  name, so a write landing in a folder the owner sanctioned with
   *  `extra_file_roots` is not a surprise that needs the owner again. A flagged
   *  exit still cards — auto-approval is a claim about the tool's inputs, not about
   *  what this chat has read. */
  declaredSafe: boolean;
  /** This chat has taken in content from outside this machine. */
  untrustedContent: boolean;
  /** This chat has read (or was approved to read) a secret file. */
  readSecret: boolean;
}

export interface UntrustedExitVerdict {
  /** Whether a card must open. False means the call runs now, with no card, and
   *  therefore with no `gate` row: "zero cards" is something the log can prove. */
  card: boolean;
  /** Which flag raised this card, for the refusal text. */
  flaggedBy?: FlaggedBy;
  /**
   * Which kind of gate this card is. Set to `taintGate` only when the flag
   *  is what raised it: the owner's answer, and nothing else, may settle it
   *  (the plan's "plain owner card"). A card a tool gate raised keeps that
   *  gate's own kind, which this file does not override.
   */
  gateKind?: 'ownerGate' | 'taintGate' | 'denyList';
  /** One line saying what this call does that the flag makes expensive. */
  cardReason?: string;
  /** The way forward, so a refusal changes the agent's next move instead of only
   *  saying no. It travels back with the decline text too. */
  alternative?: string;
}

/** The way forward a flagged exit names, in the agent's own words. */
export const FLAGGED_EXIT_ALTERNATIVE =
  'Ask the owner in your final reply, or do the step with a tool that does not ' +
  'leave the machine; the owner approves this card when they return.';

/**
 * The one sentence each flag carries when an autonomous run refuses an exit.
 *
 * Two sentences, not one, because the two flags say different things about the
 * chat and the agent acts on the difference: a chat that read `.env` is refused
 * because of what it READ, a chat that read a page is refused because of what it
 * TOOK IN, and those point at different next steps. `refusalReasonForGate` picks
 * between them from the flags, and never guesses — the same rule that keeps
 * `/clanker`'s refusal from naming the wrong reason nobody answered it.
 */
export const UNTRUSTED_EXIT_REFUSAL_REASON =
  'This chat has taken in content from outside — a page, a search result, a ' +
  'browser snapshot or an MCP reply — so nothing it chose to send out is ' +
  "certainly the owner's choice. Nothing more is sent out of it without you.";

export function refusalReasonForFlag(flaggedBy: FlaggedBy): string {
  if (flaggedBy === 'secret') return SECRET_TAINT_REFUSAL_REASON;
  return UNTRUSTED_EXIT_REFUSAL_REASON;
}

/**
 * Which of those two sentences an autonomous refusal carries, read from the chat.
 *
 * `ToolApprovalService` asks this rather than picking a string itself, because it
 * holds only a conversation id while the difference lives in what that chat read.
 * When neither flag is set the gate's own line is used: a card raised `taintGate`
 * for some other reason knows its reason better than this file does, and inventing
 * one would put words in a gate that said something specific.
 */
export function refusalReasonForGate(
  conversationId: string | undefined,
  cardReason?: string,
): string {
  if (conversationId && hasConversationReadSecret(conversationId))
    return refusalReasonForFlag('secret');
  if (conversationId && hasConversationReadUntrusted(conversationId))
    return refusalReasonForFlag('content');
  return cardReason ?? refusalReasonForFlag('content');
}

/**
 * The decision itself, as a pure function: nothing in it reads a store, a config
 * or a timer, so the whole rule can be tested from a table of inputs.
 */
export function decideUntrustedExit(input: UntrustedExitInput): UntrustedExitVerdict {
  const flaggedBy: FlaggedBy | undefined = input.readSecret
    ? 'secret'
    : input.untrustedContent
      ? 'content'
      : undefined;
  // These conditions create a candidate card. The chat approval layer lets attended
  // Clanker answer it unless it is a deny-list, owner-only, destructive, or secret-egress stop.
  const gateCard =
    input.dangerous || input.toolGate || (input.outsideWorkspace && !input.declaredSafe);
  const exitCard = flaggedBy !== undefined && input.reachesOut !== 'none';
  if (!gateCard && !exitCard) return { card: false };
  // The flag raised this card only when no gate did: that is the case this file
  // exists for, and the only one whose judge it may choose.
  if (exitCard && !gateCard) {
    const label =
      input.reachesOut === 'none' ? '' : EXIT_LABELS[input.reachesOut as Exclude<ExitKind, 'none'>];
    return {
      card: true,
      flaggedBy,
      gateKind: 'taintGate',
      cardReason:
        `This chat has read ${FLAG_LABELS[flaggedBy ?? 'content']} and this call ` +
        `${label}. Approve it, or the agent will report the step as not done.`,
      alternative: FLAGGED_EXIT_ALTERNATIVE,
    };
  }
  return { card: true, ...(flaggedBy ? { flaggedBy } : {}) };
}
