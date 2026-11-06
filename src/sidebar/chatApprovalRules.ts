/**
 * The chat's approval rules: what THIS conversation has been allowed to do, and the
 * one place that decides whether that covers what a call needs.
 *
 * A rule is a key string (`approvalKey.ts` validates it), stored on the
 * conversation record as `approval_rules` — persisted exactly the way
 * `untrusted_since_ms` is, because a rule that a window reload lost would silently
 * put the card back, and a rule that outlived its chat would answer a card for a
 * chat that never earned it. `docs/plans/ASK_ONCE_APPROVALS_PLAN.md` §7 is the
 * lifecycle ledger for it: created by an "Allow for this chat" click, deleted by
 * Reset, `/clear`, a new chat or deleting the chat, never by turning Clanker off.
 *
 * One source of truth per key, and two readers of it. `net:<host>` is answered
 * live from `fetchHostApprovals.ts` (which `fetch.allowed_hosts` also feeds, so a
 * second copy of "this chat may reach huggingface.co" would be a rule one module
 * knows about and the fetch gate does not), but an "Allow for this chat" click on
 * a host now ALSO records the key here, because the fetch store is in memory and
 * a reload would otherwise forget an approval the owner made — `seedChatHostApprovals`
 * puts the live set back from this record wherever a conversation is loaded, so the
 * record is the durable copy and the store stays the one live source. Everything
 * else — `net:prog:`, `cross_chat`, `delegate:`, `write:`, `secret:`, `tool:`,
 * `rdelete:` — lives here and nowhere else.
 *
 * `allowForChat` had no UI caller until phase 3b added the card button; its tests
 * were its callers for now, and Claude commits the phases together.
 */
import * as os from 'os';
import {
  approvedHostsFor,
  clearConversationHostApprovals,
  hostApprovedForChat,
  markHostApproved,
} from '../tools/fetchHostApprovals';
import { ownerOnlySetFor } from '../tools/ownerPaths';
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
  NET_KEY,
  NET_PROG_KEY,
  approvalKeysFor,
  approvalKeysText,
  delegateTargetFor,
  ruleCovers,
  validateRuleKey,
  type ApprovalKeyContext,
  type ApprovalKeyInput,
  type CallApprovalKeys,
} from './approvalKey';
import type { ConversationRuntime } from './sessionTypes';

/** The environment `approvalKey.ts` needs, assembled from what this window knows:
 *  its config, its workspace folder and the owner-only roots.
 *
 *  This is the impure half of the key story on purpose — `approvalKey.ts` itself
 *  reads nothing, so the same code answers for a chat rule today and for
 *  `policy.yaml` in phase 4. `os.homedir()` and `process.platform` are read here
 *  because they are the machine, not the chat, and a test injects its own.
 */
export function approvalEnvFor(options: {
  getConfig?: () => ForgeConfig | undefined;
  workspaceRoot?: string;
  home?: string;
  platform?: NodeJS.Platform;
  /** The config file this window actually loads, so the owner-only root set is the
   *  one this window has (`ownerPaths.ts` asks whether the policy file exists). */
  configPath?: string;
}): { ctx: ApprovalKeyContext; config: ForgeConfig | undefined } {
  const config = options.getConfig?.();
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const workspaceRoot = options.workspaceRoot;
  const set = ownerOnlySetFor({
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
    home,
    platform,
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
  });
  return {
    ctx: {
      platform,
      home,
      workspaceRoot,
      ownerOnly: set.roots,
      extraFileRoots: config?.extra_file_roots ?? [],
    },
    config,
  };
}

/** Has this chat already been allowed every key this call needs?
 *
 *  False for `unkeyable` — that is the plan's fail-closed half, and it is what
 *  makes "deny-list dangerous commands still get a card" true without a list of
 *  commands here. A `net:<host>` requirement is answered from the fetch store (so
 *  `fetch.allowed_hosts` counts too); every other key is matched against the
 *  chat's rules with `ruleCovers`, which refuses a rule that is not a legal key.
 */
export function coveredByChatRules(
  conversation: ConversationRuntime | undefined,
  conversationId: string | undefined,
  keys: CallApprovalKeys,
  ctx: ApprovalKeyContext,
  config: ForgeConfig | undefined,
): boolean {
  if (keys.kind !== 'keyed' || keys.requirements.length === 0) return false;
  const rules = conversation?.approval_rules ?? [];
  const hostApproved = hostApprovedForChat(config, conversationId);
  return keys.requirements.every((requirement) => {
    const key = requirement.key;
    if (key.startsWith(NET_PROG_KEY))
      return rules.some((rule) => ruleCovers(rule, requirement, ctx));
    if (key.startsWith(NET_KEY)) {
      const host = key.slice(NET_KEY.length);
      if (validateRuleKey(key, ctx) !== undefined) return false;
      return hostApproved(host);
    }
    return rules.some((rule) => ruleCovers(rule, requirement, ctx));
  });
}

/**
 * Record "allow this for the rest of this chat". Returns the one-line reason it
 * was refused, or undefined when it was taken.
 *
 * It validates before storing, so a key that reaches past the walls (a rule for
 * `~/.forge/`, for the workspace root itself, for `C:/Windows`) can never be
 * stored, and `ruleCovers` can then trust what it reads. It dedupes, so a chat
 * that clicked twice does not grow a list of identical rules.
 *
 * A `net:<host>` is written TWICE on purpose, and not as two rules: the fetch
 * store is what the fetch gate actually reads (`coveredByChatRules` keeps asking
 * it, so `fetch.allowed_hosts` and a click cannot disagree), while this record is
 * the copy that survives a window reload — `seedChatHostApprovals` rebuilds the
 * live set from it wherever conversations load. A `net:prog:` key names a program,
 * not a host, so it is stored here only, exactly as before.
 *
 * It does NOT save the conversation: the caller owns the write, exactly as every
 * other in-place conversation mutation does (`ToolDispatch.ts` stamps
 * `untrusted_since_ms` and the next save carries it).
 */
export function allowForChat(
  conversation: ConversationRuntime,
  conversationId: string | undefined,
  key: string,
  ctx: ApprovalKeyContext,
): string | undefined {
  const value = key.trim();
  const invalid = validateRuleKey(value, ctx);
  if (invalid) return invalid;
  const rules = conversation.approval_rules ?? [];
  const already = rules.some((stored) => stored.trim().toLowerCase() === value.toLowerCase());
  // `net:prog:` is a program, not a host, and the fetch store has no idea what a
  // program is: only the plain `net:<host>` form goes there, and only that form
  // needs the durable copy below.
  if (!value.startsWith(NET_PROG_KEY) && value.startsWith(NET_KEY)) {
    markHostApproved(conversationId, value.slice(NET_KEY.length).toLowerCase());
    if (!already) conversation.approval_rules = [...rules, value];
    return undefined;
  }
  if (already) return undefined;
  conversation.approval_rules = [...rules, value];
  return undefined;
}

/** Rebuild one chat's live approved-host set from the `net:` rules its record
 *  carries. Called where a conversation is loaded or restored — `persistedToRuntime`
 *  in `sessionPersistence.ts`, the one place every record in this window comes
 *  through — because the fetch store is in memory and dies with the window, so
 *  without this an "Allow for this chat" on a host would be gone after a reload
 *  while the chat's own record still said it was allowed.
 *
 *  It ADDS and never removes: a chat that reset its rules starts with an empty
 *  record and an empty store, and a host approved by an ordinary Approve click is
 *  not in the record, so a reload is allowed to forget that one (it asked again
 *  before, and will again). Reading a rule is not re-approving a host nobody used:
 *  these are hosts this chat was already told it may reach.
 */
export function seedChatHostApprovals(conversation: ConversationRuntime): void {
  for (const rule of conversation.approval_rules ?? []) {
    const value = rule.trim();
    if (!value.startsWith(NET_KEY) || value.startsWith(NET_PROG_KEY)) continue;
    const host = value.slice(NET_KEY.length).toLowerCase();
    if (host.length > 0) markHostApproved(conversation.id, host);
  }
}

/** Drop this chat's rules: `/clear`, Reset approvals, a new chat, a deleted chat.
 *  Written as an empty list rather than deleted, so the open-chat signature sees
 *  the change and the save cannot skip it. */
export function clearChatRules(conversation: ConversationRuntime): void {
  conversation.approval_rules = [];
}

/** Reset approvals for one chat: its rules AND the hosts it approved, because a
 *  `net:` host is a rule the owner was shown and clicked, and clearing half of it
 *  would leave the fetch gate answering a card the owner just took away. Clanker
 *  is NOT touched — turning the mode off revokes nothing (plan §4), and Reset is
 *  the only thing that clears rules. Used by `/approvals reset`, the sessions
 *  panel's `Reset approvals` and the remote command, so all three clear the same
 *  set. Does not save: the caller owns the write, as everywhere else.
 */
export function resetChatApprovals(conversation: ConversationRuntime): void {
  clearChatRules(conversation);
  clearConversationHostApprovals(conversation.id);
}

/** Every rule this chat holds, for `/approvals` (phase 3) and for the tests. */
export function chatRules(conversation: ConversationRuntime): readonly string[] {
  return conversation.approval_rules ?? [];
}

/** The rules visible to the owner for this chat, including host approvals held
 *  in the existing fetch-host store. */
export function approvalLinesForChat(
  conversationId: string,
  conversation: ConversationRuntime,
): string[] {
  const keys = new Set([
    ...chatRules(conversation),
    ...approvedHostsFor(conversationId).map((host) => `${NET_KEY}${host}`),
  ]);
  return [...keys]
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${describeApprovalKeys([key])}  (${key})`);
}

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

/** What the seam answers with when a card is about to open:
 *
 * - `answered` — a chat rule, or this chat's Clanker, covered every key, so no
 *   card opens and the `gate` row names the key that answered it;
 * - `offer` — nothing covered it AND this call has keys the owner could allow, so
 *   the card opens with "Allow for this chat" between Decline and Approve;
 * - `undefined` — the card opens with Approve and Decline only, because this call
 *   has no key (`approvalKey.ts` `unkeyable`) or because nobody is in the run to be
 *   shown a button. A deny-list command like `git rebase` lands here, which is what
 *   keeps plan §2's "the deny list always asks the owner" true on the CARD as well
 *   as in the queue, and is why a keyed recursive delete gets the button while
 *   `git rebase` never does.
 */
export type ChatRuleDecision =
  | { kind: 'answered'; key: string }
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
 * is there to answer. Attended chats do, and in the order the plan sets: the rules
 * the owner clicked for this chat first, then Clanker for this chat, which lets a
 * key the owner could have allowed run, including dangerous calls. The deny list
 * and secret-read taint stay owner-only: the deny list's card is promised by the
 * banner, and only the owner can judge what a secret-tainted chat may send. What
 * neither answers opens its card: a
 * deny-list command, or any call with no key the owner could allow, waits like any
 * other card, and times out under `permissions.approval_timeout_minutes` when the
 * owner set one. `/clanker` refuses nothing without a card any more, so the queue's
 * own behaviour is unchanged by this seam.
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
    decide: (call) => {
      const { ctx, config } = env();
      const keyInput = keyInputFor(call);
      const keys = approvalKeysFor(keyInput, ctx);
      if (keys.kind !== 'keyed') return undefined;
      const approvalKey = approvalKeysText(keys);
      const unattended = unattendedConversations.has(call.conversationId);
      const policy = approvalPolicyDecision(
        policySession.rulesFor(config?.approvals),
        keys.requirements,
        ctx,
        options.workspaceRoot,
        unattended,
        unattendedConversations.jobMeta(call.conversationId)?.jobId,
      );
      const answered = (answeredBy: 'policy_rule' | 'chat_rule' | 'clanker'): string => {
        options.recordAutoGate({
          toolName: call.toolName,
          ...(call.approvalMetadata?.detail ? { detail: call.approvalMetadata.detail } : {}),
          conversationId: call.conversationId,
          ...(call.dangerous ? { dangerous: true } : {}),
          approvalKey,
          answeredBy,
        });
        return approvalKey;
      };
      if (policy.kind === 'allowed') {
        return { kind: 'answered', key: answered('policy_rule') };
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
          key: approvalKey,
        };
      }
      if (coveredByChatRules(call.conversation, call.conversationId, keys, ctx, config)) {
        return { kind: 'answered', key: answered('chat_rule') };
      }
      // Clanker is last and chat-scoped. Deny-list recursive deletes can have a key,
      // so they stay gated here even though an owner chat rule may still answer them.
      const denyList =
        keyInput.approvalGateKind === 'denyList' || keyInput.exitGateKind === 'denyList';
      if (
        !denyList &&
        call.approvalMetadata?.secretReadTaint !== true &&
        options.clankerMode?.(call.conversationId) === true
      ) {
        return { kind: 'answered', key: answered('clanker') };
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
