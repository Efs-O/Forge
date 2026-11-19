/**
 * The chat-rule DECISION: what one gated call gets, read from the rules this chat
 * already holds, and the two writes that follow the owner's click (`allow`,
 * `always`). The rules themselves — what may be stored, the fetch-store split for
 * `net:`, what clears them — stay in `./chatApprovalRules`, which this module reads
 * and never answers to; the split is storage vs. the per-call verdict that reads it.
 */
import { unattendedConversations } from './unattendedConversations';
import { describeApprovalKeys } from './approvalKeyWords';
import { approvalPolicyDecision, type AlwaysApprovalWriteResult } from './approvalPolicyRules';
import { createApprovalPolicySession } from './approvalPolicySession';
import type { ApprovalOffer } from './approvalMessages';
import type { ForgeConfig } from '../config/types';
import type { ToolApprovalMetadata } from '../tools/toolContract';
import type { ToolApprovalAutoApprovedEvent } from './toolApprovalEvents';
import type { UntrustedExitVerdict, ExitKind } from './untrustedExitPolicy';
import {
  approvalKeysFor,
  approvalKeysText,
  delegateTargetFor,
  type ApprovalKeyInput,
} from './approvalKey';
import { allowForChat, approvalEnvFor, coveredByChatRules } from './chatApprovalRules';
import type { ConversationRuntime } from './sessionTypes';

/**
 * Everything the chat-rule decision needs about one gated call — in the shape
 * `ToolDispatch` already has it, so the dispatch stays a lookup and every rule that
 * decides whether a card may be skipped lives here.
 */
export interface ChatRuleCall {
  toolName: string;
  args: Record<string, unknown>;
  /** The tool's own gate called this dangerous. */
  dangerous: boolean;
  /** The tool's own gate wants the owner to see this call.
   *  (`approvalMetadata !== undefined && !cardTextOnly`.) */
  toolGate: boolean;
  outsideWorkspace: boolean;
  declaredSafe: boolean;
  reachesOut: ExitKind;
  /** The metadata the tool's gate returned, whatever it knows about this call. */
  approvalMetadata: ToolApprovalMetadata | undefined;
  /** The card rule's verdict for this call, which says whether the flag or a gate
   *  raised the card being skipped. */
  exitVerdict: UntrustedExitVerdict;
  mutationPaths: readonly string[];
  outsideMutationPaths: readonly string[];
  conversationId: string;
  conversation: ConversationRuntime | undefined;
}

/** Queue outcome: `answered` bypasses the card, and `offer` adds chat/project rules.
 * `undefined` leaves the queue to apply the Clanker stop filter and card behavior.
 */
export type ChatRuleDecision =
  | { kind: 'answered'; key?: string }
  | { kind: 'offer'; offer: ApprovalOffer; alwaysInProject?: ApprovalOffer }
  | { kind: 'policy-denied'; allowPath: string; key: string };

/** A key an "Allow for this chat" click could not store, with the reason it
 *  refused it — reported to the owner, because the call ran either way and a rule
 *  that did not land means the next identical call asks again.
 */
export interface ChatRuleAllowFailure {
  key: string;
  reason: string;
}

/** The seam, in both directions: `decide` answers a card about to open from the
 *  rules this chat already holds, and `allow` stores the keys the card offered when
 *  the owner clicked. Both read the same environment and the same conversation
 *  record, which is what makes the answer a card shows and the rule the click writes
 *  one fact read twice rather than two facts that can disagree.
 */
export interface ChatRuleApproval {
  decide(call: ChatRuleCall): ChatRuleDecision | undefined;
  /** Read the same chat-scoped flag for tool behavior that is not an approval card. */
  isClankerEnabled?(conversationId: string): boolean;
  /** Store each offered key as this chat's rule and save the chat. Returns the keys
   *  it refused, which should be none (`decide` validated them before the card was
   *  built) and is shown to the owner when it is not.
   */
  allow(conversationId: string, keys: readonly string[]): readonly ChatRuleAllowFailure[];
  /** Persist the owner's separate "Always in this project" click. */
  always(keys: readonly string[]): AlwaysApprovalWriteResult;
}

/** The key input for one gated call, read from the pieces `ToolDispatch` handed
 *  over. `delegateTarget` comes from the argument that names the target agent, so
 *  the dispatch does not have to know which tool names its target where. */
function keyInputFor(call: ChatRuleCall): ApprovalKeyInput {
  const metadata = call.approvalMetadata;
  const delegateTarget = delegateTargetFor(call.toolName, call.args);
  return {
    toolName: call.toolName,
    dangerous: call.dangerous,
    toolGate: call.toolGate,
    outsideWorkspace: call.outsideWorkspace,
    declaredSafe: call.declaredSafe,
    reachesOut: call.reachesOut,
    ...(metadata?.approvalKey !== undefined ? { approvalKey: metadata.approvalKey } : {}),
    ...(metadata?.approvalTargets !== undefined
      ? { approvalTargets: metadata.approvalTargets }
      : {}),
    ...(metadata?.gateKind !== undefined ? { approvalGateKind: metadata.gateKind } : {}),
    ...(call.exitVerdict.gateKind !== undefined ? { exitGateKind: call.exitVerdict.gateKind } : {}),
    ...(delegateTarget !== undefined ? { delegateTarget } : {}),
    mutationPaths: call.mutationPaths,
    outsideMutationPaths: call.outsideMutationPaths,
  };
}

/**
 * The one place that decides "this chat already allowed this" for a card about to
 * open, built once per window because it needs the window's config, its workspace
 * folder and its route to the gate ledger.
 *
 * An unattended run — a job, an unattended bus turn — never asks a chat's rules or
 * Clanker, the same predicate `ToolApprovalService` uses to refuse an exit nobody
 * is there to answer. Attended chats do, in order: owner-created rules, then
 * Clanker. Clanker answers keyed and unkeyable calls, including dangerous ones,
 * except deny-list matches, the owner-only wall, marked destructive actions, and
 * egress after a secret read. Other unanswered calls open their card; unattended
 * runs keep their existing policy-denied and queue behavior.
 *
 * `allow` is the other half of the same object, and it belongs here for one reason:
 * the environment that decided a card may be skipped is the environment that
 * validates the rule the click writes, so a card cannot offer a key the store would
 * then refuse, and a key the store accepts is one the card was allowed to name.
 */
export function createChatRuleApproval(options: {
  getConfig?: () => ForgeConfig | undefined;
  workspaceRoot?: string;
  configPath?: string;
  /** The home and platform to judge keys against. Absent: this machine's, which is
   *  what a window has; injectable so a test can pin a win32 home without running on
   *  Windows. */
  home?: string;
  platform?: NodeJS.Platform;
  /** Whether THIS chat has Clanker on, read from the queue that owns the flag
   *  (`ToolApprovalService.getClankerMode`) so both decision points see one answer.
   *  Absent: no chat has it, which is what a window with nothing armed has, and what
   *  a test that arms one replaces. */
  clankerMode?: (conversationId: string) => boolean;
  recordAutoGate(event: ToolApprovalAutoApprovedEvent): void;
  /** The conversation whose record these rules live on, read when a click writes
   *  them. Absent: this window has no records to write — the shape a window that has
   *  loaded no conversations has, and the shape a test that hands in its own chat
   *  replaces. */
  lookup?: (conversationId: string) => ConversationRuntime | undefined;
  /** Save the chat whose rules just changed. `allow` calls it once per click: a rule
   *  no save carried is a rule a reload forgets, and a rule the owner clicked that a
   *  reload forgot asks for its card again — which fails closed, the way plan §7 says
   *  a lost save must.
   */
  persist?: (conversationId: string) => void;
  /** Present only when this chat has a workspace and ConfigWriter is wired. */
  writeAlways?: (keys: readonly string[]) => AlwaysApprovalWriteResult;
}): ChatRuleApproval {
  /** The window's key environment, read on every call rather than captured once: a
   *  config edit, a changed workspace folder or a rotated policy lock has to be seen
   *  by the next decision, not baked into the seam built at startup.
   */
  const env = () =>
    approvalEnvFor({
      ...(options.getConfig ? { getConfig: options.getConfig } : {}),
      ...(options.workspaceRoot !== undefined ? { workspaceRoot: options.workspaceRoot } : {}),
      ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
      ...(options.home !== undefined ? { home: options.home } : {}),
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
    });
  const policySession = createApprovalPolicySession({
    ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
    ...(options.getConfig ? { getConfig: options.getConfig } : {}),
  });
  return {
    isClankerEnabled: (conversationId) => options.clankerMode?.(conversationId) === true,
    decide: (call) => {
      const { ctx, config } = env();
      const keyInput = keyInputFor(call);
      const keys = approvalKeysFor(keyInput, ctx);
      const approvalKey = keys.kind === 'keyed' ? approvalKeysText(keys.requirements) : undefined;
      const unattended = unattendedConversations.has(call.conversationId);
      function answered(answeredBy: 'policy_rule' | 'chat_rule' | 'clanker'): string | undefined {
        options.recordAutoGate({
          toolName: call.toolName,
          ...(call.approvalMetadata?.detail ? { detail: call.approvalMetadata.detail } : {}),
          conversationId: call.conversationId,
          ...(call.dangerous ? { dangerous: true } : {}),
          ...(approvalKey !== undefined ? { approvalKey } : {}),
          answeredBy,
        });
        return approvalKey;
      }
      // The owner-only wall is the first result from approvalKeysFor, before any
      // policy or Clanker lookup. Keep that ordering even for a keyless call.
      if (keys.kind === 'unkeyable' && keys.ownerOnly) return undefined;
      const clankerMayAnswer =
        !unattended &&
        options.clankerMode?.(call.conversationId) === true &&
        keyInput.approvalGateKind !== 'denyList' &&
        keyInput.exitGateKind !== 'denyList' &&
        call.approvalMetadata?.clankerStop !== true &&
        call.approvalMetadata?.secretReadTaint !== true &&
        !(call.exitVerdict.flaggedBy === 'secret' && call.reachesOut !== 'none');
      if (keys.kind !== 'keyed') {
        if (clankerMayAnswer) {
          const key = answered('clanker');
          return { kind: 'answered', ...(key !== undefined ? { key } : {}) };
        }
        return undefined;
      }
      const policy = approvalPolicyDecision(
        policySession.rulesFor(config?.approvals),
        keys.requirements,
        ctx,
        options.workspaceRoot,
        unattended,
        unattendedConversations.jobMeta(call.conversationId)?.jobId,
      );
      if (policy.kind === 'allowed') {
        return { kind: 'answered', key: answered('policy_rule') as string };
      }
      if (unattended) {
        const job = unattendedConversations.jobMeta(call.conversationId);
        return {
          kind: 'policy-denied',
          allowPath:
            policy.kind === 'denied'
              ? policy.allowPath
              : job
                ? `approvals.jobs.${job.jobId}.allow`
                : 'approvals.unattended_bus.allow',
          key: approvalKeysText(keys.requirements),
        };
      }
      if (coveredByChatRules(call.conversation, call.conversationId, keys, ctx, config)) {
        return { kind: 'answered', key: answered('chat_rule') as string };
      }
      // Clanker is last and chat-scoped. Deny-list recursive deletes can have a key,
      // so they stay gated here even though an owner chat rule may still answer them.
      const denyList =
        keyInput.approvalGateKind === 'denyList' || keyInput.exitGateKind === 'denyList';
      if (clankerMayAnswer && !denyList) {
        return { kind: 'answered', key: answered('clanker') as string };
      }
      // These validated keys define both the card copy and what its button stores.
      // `approvalKeysFor` makes invalid or wall-reaching keys unkeyable first.
      const offered = keys.requirements.map((requirement) => requirement.key);
      const offer = { keys: offered, label: describeApprovalKeys(offered) };
      return {
        kind: 'offer',
        offer,
        ...(options.workspaceRoot && options.configPath && options.writeAlways
          ? { alwaysInProject: offer }
          : {}),
      };
    },
    allow: (conversationId, offeredKeys) => {
      const conversation = options.lookup?.(conversationId);
      if (!conversation) {
        // A chat this window cannot see has no record to write the rule on, so the
        // click still runs the call it approved and reports why the rule did not.
        return offeredKeys.map((key) => ({
          key,
          reason: 'this window has no record for this chat, so the rule was not stored',
        }));
      }
      const { ctx } = env();
      const failures: ChatRuleAllowFailure[] = [];
      for (const key of offeredKeys) {
        const reason = allowForChat(conversation, conversationId, key, ctx);
        if (reason) failures.push({ key, reason });
      }
      // Save even when every key was refused: the save is cheap (the open-chat
      // signature compares what changed and skips an unchanged record), and a click
      // that stored a `net:` host in the fetch store has already changed live state
      // the record has to agree with.
      options.persist?.(conversationId);
      return failures;
    },
    always: (keys) => {
      const result = options.writeAlways?.(keys) ?? {
        kind: 'failed' as const,
        message: 'Always in this project is unavailable for this chat.',
      };
      if (result.kind === 'written') policySession.rememberWritten(keys);
      return result;
    },
  };
}
