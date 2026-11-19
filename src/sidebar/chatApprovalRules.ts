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
import { openForgeFileRoots } from '../tools/ownerPathsOpen';
import { describeApprovalKeys } from './approvalKeyWords';
import type { ForgeConfig } from '../config/types';
import {
  NET_KEY,
  NET_PROG_KEY,
  ruleCovers,
  validateRuleKey,
  type ApprovalKeyContext,
  type CallApprovalKeys,
} from './approvalKey';
import type { ConversationRuntime } from './sessionTypes';

/** Environment for `approvalKey.ts`: this window's config, workspace and owner-only roots.
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
      extraFileRoots: [...(config?.extra_file_roots ?? []), ...openForgeFileRoots(home)],
    },
    config,
  };
}

/** Has this chat already been allowed every key this call needs?
 *
 *  False for `unkeyable`. The caller applies Clanker's separate stop filter to
 *  those calls: non-protected ones are answered, while the deny list and owner-only
 *  wall remain in force. A `net:<host>` requirement is answered from the fetch
 *  store (so `fetch.allowed_hosts` counts too); every other key is matched against
 *  the chat's rules with `ruleCovers`, which refuses a rule that is not a legal key.
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
