/**
 * The tool contract: what a registered tool is, what its handler may return, and
 * what an approval gate may say about a call.
 *
 * Split out of `ToolRegistry.ts` at the seam that was already there: a tool author
 * reads these declarations to learn what to declare, and `ToolRegistry.ts` is the
 * machine that validates arguments and dispatches the call. They change for
 * different reasons, and the registry file crossed ESLint's 500-line stop the
 * moment phase 4 added the two fields the untrusted-content rule needs
 * (`untrustedResult`, `reachesOut`). Everything here is re-exported from
 * `ToolRegistry.ts`, so every `import ... from './ToolRegistry'` keeps working.
 */
import type { ChatMessage, ContentPart, ToolDefinition } from '../llm/types';
import type { QuestionAnswerRecord } from '../util/questionAnswers';
import type { PlanItem, ConversationRuntime } from '../sidebar/sessionTypes';
import type { CheckinStage } from '../agent/elapsedTimeNote';
import type { ToolOutputLimits } from './toolOutputLimits';
import type { CheckpointSession } from '../checkpoint/CheckpointStack';
export const ALL_TOOL_PERMISSIONS = [
  'read',
  'write',
  'delete',
  'terminal',
  'headless',
  'search',
  'fetch',
  'git-read',
  'git-write',
  'browser',
  'desktop',
  'delegate',
] as const;

export type ToolPermission = (typeof ALL_TOOL_PERMISSIONS)[number];

export interface ToolApprovalMetadata {
  dangerous?: boolean;
  detail?: string;
  /**
   * What the agent should do instead, shown back to it when the user declines.
   *
   * The shell classifier already knows the sanctioned alternative for every
   * rule it matches, and that string used to be shown only for `refused`
   * commands (`shellTool.ts`). A declined `dangerous` call came back as a bare
   * `User declined: shell`, so the agent retried the same command or invented
   * another one; the hint is what turns a refusal into a course change.
   */
  declineHint?: string;
  /**
   * Which kind of gate this call's gate is, set by the gate that raises the card.
   * It classifies the gate for an autonomous run — it does not choose who answers
   * it, and no automated answer is offered for any of the three.
   *
   * `ownerGate` is the exfil gates' request: the decision belongs to the owner,
   * so in an autonomous run (`/clanker`, an unattended turn, a job), where
   * nobody is at the card, the call is refused at once instead of waiting.
   * `taintGate` is the opposite half of the same fact: a fetch in a chat that
   * has read a secret may be answered by the owner and nothing else, because
   * nothing else can see what this chat has already read — so it is refused
   * at once in every autonomous run, `/clanker` included, where nothing can
   * answer the card it would raise either. `denyList` is the deny list's own
   * answer: in an autonomous run there is no judgement to make — refuse at once,
   * with no card, and name the sanctioned tool in `declineHint` — while attended
   * mode keeps its card and its wait exactly as before, `taintGate`'s card
   * included. Absent means the ordinary rule: a dangerous call keeps its card
   * and waits for the owner, and an unattended run refuses it because nobody
   * is there to answer it. The gate that raises the card sets it; `ToolApprovalService`
   * is what honours it, so the rule cannot be talked around by a prompt.
   */
  gateKind?: 'ownerGate' | 'taintGate' | 'denyList';
  /** What made this card exist, in one line, from the gate that knows it: a
   *  matched secret pattern, a new host, a payload size. It is the reason the
   *  gate was raised, and it travels with the refusal so the agent can act on
   *  it instead of guessing. */
  cardReason?: string;
  /**
   * Which way this call leaves the machine, if it does: `network` for a command
   * or request that sends bytes to another host, `cross_chat` for a message
   * handed to a different chat, `delegation` for a task given to another model.
   *
   * Set by the gate that knows — `shellTool.ts` for a command whose program
   * reaches the network — and read by `src/sidebar/untrustedExitPolicy.ts`, which
   * turns it into a card only when this chat has outside content or a secret in
   * it. A chat with neither runs the same command with no card, because it has
   * nothing there for an outside page to have chosen to send.
   */
  reachesOut?: 'network' | 'cross_chat' | 'delegation';
  /** True when this metadata is only the card's TEXT: the tool's own gate found
   *  nothing to ask about, and a card would have existed only because of the
   *  permission rule. `shellTool.ts` sets it for a command the classifier called
   *  `normal` — the cwd and shell lines are worth showing when a card does open,
   *  but they are not a reason to raise one, and treating them as one would put a
   *  card on every build a clean chat runs. */
  cardTextOnly?: boolean;
  /**
   * The approval key for this call, in the shape `approvalKey.ts` reads
   * (`net:<host>`, `net:prog:<program>`, `secret:<file>`, `rdelete:<folder>`).
   *
   * Set ONLY by the gate that knows the answer — the fetch gate knows the host it
   * is asking about, the shell classifier knows the program that reaches a host, a
   * secret gate knows the file it matched, a recursive-delete rule knows the folder
   * its targets sit in — and read by exactly one module, `src/sidebar/approvalKey.ts`.
   * A gate that cannot name one of those sets nothing, and the call asks every
   * time: a key guessed from a path the gate could not read would be an approval
   * the owner never made. Absent is the common case.
   */
  approvalKey?: string;
  /** The targets behind an `rdelete:` or `write:` key, resolved by the same gate
   *  that set it. Every one must lie inside the key's folder, or the key is wider
   *  than the card and `approvalKeysFor` refuses it. */
  approvalTargets?: readonly string[];
}

export interface MultimodalToolResult {
  text: string;
  content: ContentPart[];
}

export interface QuestionToolResult {
  text: string;
  questionRecord: QuestionAnswerRecord;
}

export type ToolHandlerResult = string | MultimodalToolResult | QuestionToolResult;

export interface ToolHandler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool args are schema-validated at call site
  (args: Record<string, unknown>, context?: ToolHandlerContext): Promise<ToolHandlerResult>;
}

export interface ToolHandlerContext {
  beforeMutate(paths: string[]): void;
  /** Caller's AbortSignal, threaded through for long-running tools. */
  abortSignal?: AbortSignal;
  /** Conversation the call belongs to. */
  conversationId?: string;
  /** Current call id, used by shell spill files. */
  toolCallId?: string;
  /** Resolved model name, used by model-specific tool-group refusals. */
  modelName?: string;
  /** Whether the resolved model accepts image input. */
  isVisionModel?: boolean;
  /** Stable, configuration-derived output bounds for the selected model. */
  outputLimits?: ToolOutputLimits;
  /** Full raw transcript for the current conversation. Read-only tools may use
   * this to recover an earlier result without widening the model prompt. */
  conversationMessages?: readonly ChatMessage[];
  /**
   * Records the conversation's task plan (`update_plan`).
   *
   * A callback rather than a store handle, so `ToolDispatch` never gains one:
   * `ModelTurn` owns the live conversation and supplies this closure, exactly
   * as it already does for `recordFileDiff`. The host stamps the timestamp —
   * the tool supplies items only.
   */
  setPlan?: (items: PlanItem[]) => void;
  /**
   * Sets this conversation's check-in (`set_checkin`) and says when it is due.
   *
   * The same shape as `setPlan`: the tool supplies the estimate, the host owns
   * the clock — here `ElapsedTimeNote`, which also delivers the note at the
   * next tool-round gap. Optional because the note is registered late and a
   * prompt run outside a conversation turn has no clock to write to; the tool
   * refuses when it gets nothing back.
   */
  setCheckin?: (minutes: number, byThen: CheckinStage) => { dueAt: number } | undefined;
  tellArrived?: (callback: () => void) => () => void;
  /** Active chat/checkpoint supplied by ModelTurn for session-scoped agent tools. */
  conversation?: ConversationRuntime;
  checkpoint?: CheckpointSession;
  persistConversation?: () => void;
}

interface ToolMutation {
  /** Paths known from arguments/editor state before the handler executes. */
  paths(args: Record<string, unknown>): string[];
  /** Whether Forge should render file diffs for these paths. */
  showDiff?: boolean;
}

export interface RegisteredTool {
  definition: ToolDefinition;
  permission: ToolPermission;
  additionalPermissions?: readonly ToolPermission[];
  /** Extra permissions derived only after validated call arguments exist. Never used for advertisement. */
  additionalPermissionsForArgs?: (args: Record<string, unknown>) => readonly ToolPermission[];
  handler: ToolHandler;
  mutation?: ToolMutation;
  /** Mutates VS Code workspace state, which has no file path for a checkpoint. */
  workspaceStateMutation?: boolean;
  /** May resolve state first (the desktop focus approval names the window it found).
   *  `context` carries the conversation the call belongs to, because a gate that
   *  asks "has THIS chat already approved it" cannot be judged from the arguments
   *  alone (web_fetch's per-chat host set, `fetchHostApprovals.ts`). */
  approval?: (
    args: Record<string, unknown>,
    context?: { conversationId?: string },
  ) => ToolApprovalMetadata | undefined | Promise<ToolApprovalMetadata | undefined>;
  /**
   * The handler's inputs and effects are structurally bounded enough to run
   * without the normal per-call confirmation. This must never be used for a
   * general shell or a mutable operation.
   */
  autoApprove?: boolean;
  /** Per-call auto approval for narrowly classified inputs such as read-only shell commands. */
  autoApproveIf?: (args: Record<string, unknown>) => boolean;
  /** When present, called during definitions() to suppress advertisement without removing the tool. */
  advertise?: () => boolean;
  /**
   * When present, called during definitions() to advertise a definition built
   * from current state instead of the static one — e.g. naming the delegation
   * targets in the current config.yaml. `definition` stays the canonical
   * literal (the tool-audit catalog extracts it statically), so this must
   * return the same tool name and schema shape.
   */
  describe?: () => ToolDefinition;
  /**
   * Called by `invalidArgs` below, which `ToolDispatch.ts` runs before it decides
   * whether to raise a card: its text is the whole refusal in every mode, with no
   * card, no automated answer, no auto-pass. `ownerPaths.ts` uses it for Forge's own
   * config, where a handler-throw would land after the write had already been
   * allowed past the gate that decides whether the agent may touch that file.
   */
  refuseBeforeApproval?: (args: Record<string, unknown>) => string | undefined;
  /**
   * True when this tool's RESULT is content from outside this machine: a page, a
   * search engine's answer, a browser snapshot, an image-search hit, or a reply
   * from a program Forge does not control (an MCP server).
   *
   * Declared where the tool is registered and read after the handler ran:
   * `ToolDispatch.ts` marks the chat through `src/tools/exfilTaint.ts`, and
   * `AgentLoop.ts` asks the same question of the transcript when a stored flag
   * goes missing. A name list kept in `exfilTaint.ts` could not answer for an MCP
   * server's tools, whose names come from the server itself, and would drift from
   * the tools that actually exist.
   */
  untrustedResult?: boolean;
  /** Which way this tool leaves the machine when the arguments do not decide:
   *  `cross_chat` for `message_chat` and `ask_agent`, `delegation` for
   *  `ask_local_agent`. A tool whose egress depends on the call (`shell`) reports
   *  it per call through `ToolApprovalMetadata.reachesOut`. Read by
   *  `src/sidebar/untrustedExitPolicy.ts`, which cards it only in a flagged chat.
   */
  reachesOut?: 'cross_chat' | 'delegation';
  /**
   * When present, the tool requires a vision projector (mmproj). Returns the
   * refusal message (naming the model) for a non-vision model. This is the
   * single source of truth for the vision gate: both the advertise filter and
   * the dispatch refusal derive from it, so the two halves cannot drift apart.
   */
  requiresVision?: (modelName: string) => string;
}
