/**
 * The gate record: one `gate` row in the session transcript for every approval
 * card and every guard refusal.
 *
 * Why it exists is a measured fact, not a hunch. The weekend sweep over the 32
 * session logs written since 2026-10-31 (`docs/reports/security-sweep-2026-11-02/`)
 * found 161 tool failures and could attribute them to causes — 17 owner-only
 * guard refusals, 16 atomic-rename collisions, 14 outside-workspace refusals,
 * 6 drive paths the sandbox read as another OS, 1 host gate — but it could not
 * count a single approval card. Cards and their waits are in no durable record:
 * the session log has no row for them (a census of every key over 20,045 rows
 * shows none), Forge's own 86 VS Code log files contain zero approval lines,
 * and VS Code rotates its logs, so the Saturday set was already gone when the
 * sweep ran. The plan's first step was "measure the gates, then order the
 * removals by cost", and that step cannot be taken from history. This is the
 * ledger that makes it possible from now on.
 *
 * Two sources, one row shape, deliberately:
 * - `GateEventLog` is a `ToolApprovalSink`, so it sees the cards the queue
 *   already emits — no new approval state, no new timer, and it disappears when
 *   the sink is disposed.
 * - `classifyGateRefusal` reads a tool result's text, because a guard refusal
 *   never reaches the approval queue at all: it is thrown inside the tool and
 *   comes back as the tool's result. Reading it here means one recording point
 *   instead of one per guard, so a guard added next month is recorded too.
 *   Classification is for the record only — nothing about behaviour depends on
 *   it, and a missed signature loses a row, not a wall.
 *
 * Rows written by an older Forge stay readable: a log reader takes every line
 * as an opaque record (`sessionLogRows.ts`), so a `kind` it no longer writes
 * is a row it does not understand, never a parse failure.
 */
import { SECRET_TAINT_REFUSAL_REASON } from './toolApprovalOutcome';
import type {
  ToolApprovalAutoApprovedEvent,
  ToolApprovalRequestEvent,
  ToolApprovalResolvedEvent,
  ToolApprovalSink,
} from './toolApprovalEvents';

/** Which wall stopped the call. `card` is left out: a card is its own `kind`. */
export type GateEventCause =
  | 'owner_only'
  | 'outside_workspace'
  | 'secret_read'
  | 'secret_taint'
  | 'deny_list'
  | 'host_gate'
  | 'policy_deny';

export interface GateEventRow {
  type: 'gate';
  /** `card` is a gate that opened and got an answer from somebody; `refusal` is
   *  a gate that never opened because the guard refused on the spot; `auto` is a
   *  gate call a rule answered with no card at all, so the ledger still shows the
   *  decision the card would have shown. A reader that does not know a `kind` must
   *  skip the row rather than fail: `sessionLogRows.ts` takes every line as an
   *  opaque record, which is what lets a `kind` added next phase stay readable in a
   *  log written by an older Forge. */
  kind: 'card' | 'refusal' | 'auto';
  tool: string;
  /** The card's rule text, or the guard's own first line, capped so a file
   *  content echoed into a refusal cannot pad the transcript. */
  reason?: string;
  cause?: GateEventCause;
  conversation_id?: string;
  dangerous?: boolean;
  raised_ms?: number;
  answered_ms?: number;
  /** Wall-clock the chat spent blocked: the number the plan actually needs. */
  wait_ms?: number;
  /** Who answered. `cancel` is a turn that stopped while its card was open.
   *  `chat_rule`, `policy_rule` and `clanker` only appear on an `auto` row: nobody
   *  answered a card, a rule did, and naming which one is the difference between a
   *  log that can say what an owner allowed and one that cannot. */
  answered_by?: 'owner' | 'timeout' | 'cancel' | 'chat_rule' | 'policy_rule' | 'clanker';
  /** The approval key or keys that covered this call (`approvalKey.ts`),
   *  comma-joined. Only an `auto` row carries one: a card was answered by somebody
   *  reading its text, not by a key. */
  approval_key?: string;
  /** The key or keys the owner allowed with this card, comma-joined. */
  allowed_for_chat?: string;
  /** The key or keys the owner allowed for this project, comma-joined. */
  allowed_for_project?: string;
  /** The model this row was written under, so a reader can attribute it to the
   *  stretch of the session it happened in, the way every other row is. */
  model?: string;
  timestamp_ms: number;
}

/** How much of a refusal's text is worth keeping: the first line names the rule,
 *  the rest is the instruction the agent was already given. */
export const GATE_REASON_MAX_CHARS = 300;

/**
 * Signatures of guard refusals, keyed on the words the guards actually say.
 * Ordered from most specific to least, and each entry names the file that owns
 * the wording so a change there shows up here as a stale signature.
 *
 * `User declined:` and `Not run: nobody answered` are deliberately absent:
 * those are card outcomes the sink already records, and counting them as
 * refusals would double every declined card in the ledger.
 */
const GUARD_SIGNATURES: ReadonlyArray<{ cause: GateEventCause; needles: readonly string[] }> = [
  // `ownerPaths.ts` `ownerOnlyToolRefusal` and `shellPolicy.ts`'s owner rule.
  {
    cause: 'owner_only',
    // The three wordings are three different facts, and the ledger must see all
    // three as the same cause: `refuses to change` (a statement the read-only
    // table classed as a write), `moves the write` (a relative `>` that only
    // lands inside `~/.forge/` because a `cd` earlier in the line moved it), and
    // `cannot judge` (a `cd` whose folder this check cannot resolve, where
    // NOTHING was classed as a change and the refusal says so). The broad needle
    // is what makes a fourth wording added later still land here rather than in
    // `other`; the phrase belongs to this guard alone.
    needles: ["part of Forge's own files", "Forge's own files"],
  },
  // `WorkspacePaths.ts` and `resolveRealWorkspacePath`.
  {
    cause: 'outside_workspace',
    needles: [
      'Path is outside the workspace',
      'Path resolves outside the workspace',
      'Path parent resolves outside the workspace',
      'outside extra_file_roots',
    ],
  },
  // `exfilTaint.ts` through `toolApprovalOutcome.ts`: the chat already read a secret.
  { cause: 'secret_taint', needles: [SECRET_TAINT_REFUSAL_REASON] },
  // `secretPaths.ts` card copy that refuses outright, and the deny list.
  { cause: 'secret_read', needles: ['reads a secret path'] },
  { cause: 'host_gate', needles: ['a host not approved in this chat'] },
  // `toolApprovalOutcome.ts` `ToolApprovalPolicyDenied`, the unattended run: the
  // call had no key the policy allows, so this is the KEY wall — an owner could
  // have allowed it by adding the key — not a rule that says this command may
  // never run. The needle is the denial sentence alone: the `Add … to
  // ~/.forge/policy.yaml` half is where the key and the list name go, and a
  // needle spanning both would let a reworded instruction move the cause.
  { cause: 'policy_deny', needles: ['approval key denied by policy'] },
  // Two wordings, two owners, one cause: `toolApprovalOutcome.ts` again, for a
  // dangerous tool a deny rule stopped, and `shellTool.ts`'s refused-class
  // message, which now says `(deny list)` — the marker that separates a command
  // no key can ever allow from one the owner could have allowed. The old bare
  // `denied by policy` needle is gone: it matched BOTH unattended sentences, so
  // the order of the entries decided the cause, and any third wording added later
  // would land in whichever bucket happened to be listed first.
  { cause: 'deny_list', needles: ['dangerous tool denied by policy', '(deny list)'] },
];

/** What a refusal result begins with: `Error:` is a guard that threw inside the
 *  tool, `Not run:` is a card nobody answered, and `unattended:` is a call a
 *  policy denied while nobody was present (`toolApprovalOutcome.ts`).
 *  `User declined:` stays out — the sink already records that card, and counting
 *  it here would double every declined card in the ledger. */
const REFUSAL_PREFIXES = ['Error:', 'Not run:', 'unattended:'];

/** The cause of a tool result, or undefined when it is not a guard refusal. */
export function classifyGateRefusal(text: string): GateEventCause | undefined {
  if (!REFUSAL_PREFIXES.some((prefix) => text.startsWith(prefix))) return undefined;
  for (const signature of GUARD_SIGNATURES) {
    if (signature.needles.some((needle) => text.includes(needle))) return signature.cause;
  }
  return undefined;
}

/** Cap the text a row carries, on one line, so a refusal cannot echo a whole
 *  file into the transcript. */
function reasonText(value: string): string {
  const firstLine = value.split('\n')[0] ?? '';
  return firstLine.length > GATE_REASON_MAX_CHARS
    ? `${firstLine.slice(0, GATE_REASON_MAX_CHARS)}…`
    : firstLine;
}

/** The refusal row for one tool result. Built here, not inside the guard, so a
 *  guard does not have to know a log exists — and cannot change its own answer
 *  because of it. */
export function buildGateRefusalRow(
  tool: string,
  text: string,
  conversationId?: string,
  model?: string,
): GateEventRow | undefined {
  const cause = classifyGateRefusal(text);
  if (!cause) return undefined;
  return {
    type: 'gate',
    kind: 'refusal',
    tool,
    cause,
    reason: reasonText(text),
    ...(conversationId ? { conversation_id: conversationId } : {}),
    ...(model ? { model } : {}),
    timestamp_ms: Date.now(),
  };
}

export interface GateEventLogDeps {
  /** Where the row goes. Injected so the test can read what a card produced
   *  without a filesystem, and so this file owns no storage of its own. */
  write(row: GateEventRow): void;
  /** Injectable clock, so a wait can be tested without sleeping. */
  now(): number;
}

/**
 * The card side of the record. It answers nobody and decides nothing: it listens
 * to the approval queue's own events and turns each answered card into one row.
 * A card still open when the window dies is not recorded — the queue holds its
 * timer and its state, and this file takes neither over.
 */
export class GateEventLog implements ToolApprovalSink {
  /** Card id → when it opened. Cleared when the card resolves, so a long chat
   *  cannot grow this without bound. */
  private readonly raised = new Map<string, number>();

  constructor(private readonly deps: GateEventLogDeps) {}

  requested(event: ToolApprovalRequestEvent): void {
    this.raised.set(event.id, this.deps.now());
  }

  /** A re-announce that the owner is the only possible answer, for a gate that
   *  forbids any automated one. It is not an answer, so it writes no row — the
   *  `resolved` row will say `waiting_for_owner` in its reason. */
  waitingForOwner(event: ToolApprovalRequestEvent): void {
    if (!this.raised.has(event.id)) this.raised.set(event.id, this.deps.now());
  }

  /**
   * A gate call a rule answered with no card: one row, and no wait to measure.
   *
   * It never went through the queue, so there is no id in `raised` to clear and no
   * `wait_ms` to report — a call that was auto-allowed blocked nobody. The row
   * still carries the key, because "the agent ran a command I never saw" is the
   * exact question an owner needs answered from the log afterwards.
   */
  autoApproved(event: ToolApprovalAutoApprovedEvent): void {
    const row: GateEventRow = {
      type: 'gate',
      kind: 'auto',
      tool: event.toolName,
      ...(event.detail ? { reason: reasonText(event.detail) } : {}),
      ...(event.conversationId ? { conversation_id: event.conversationId } : {}),
      ...(event.dangerous ? { dangerous: true } : {}),
      // Absent when the answer was not a key: Clanker running a call that has no
      // key (`approvalKey.ts` `unkeyable`) has nothing to name, and an empty
      // `approval_key` would read as a key that was allowed and forgotten.
      ...(event.approvalKey ? { approval_key: event.approvalKey } : {}),
      answered_by: event.answeredBy,
      answered_ms: this.deps.now(),
      timestamp_ms: Date.now(),
    };
    this.deps.write(row);
  }

  resolved(event: ToolApprovalResolvedEvent): void {
    const raisedAt = this.raised.get(event.id);
    this.raised.delete(event.id);
    const answeredAt = this.deps.now();
    const answeredBy =
      event.reason === 'timeout' ? 'timeout' : event.reason === 'cancelled' ? 'cancel' : 'owner';
    const row: GateEventRow = {
      type: 'gate',
      kind: 'card',
      tool: event.toolName,
      ...(event.detail ? { reason: reasonText(event.detail) } : {}),
      ...(event.conversationId ? { conversation_id: event.conversationId } : {}),
      ...(event.dangerous ? { dangerous: true } : {}),
      ...(raisedAt ? { raised_ms: raisedAt } : {}),
      answered_ms: answeredAt,
      ...(raisedAt ? { wait_ms: Math.max(0, answeredAt - raisedAt) } : {}),
      answered_by: answeredBy,
      ...(event.decision === 'allowChat' && event.allowForChat
        ? { allowed_for_chat: event.allowForChat.keys.join(', ') }
        : {}),
      ...(event.decision === 'alwaysProject' && event.alwaysInProject
        ? { allowed_for_project: event.alwaysInProject.keys.join(', ') }
        : {}),
      timestamp_ms: Date.now(),
    };
    this.deps.write(row);
  }
}
