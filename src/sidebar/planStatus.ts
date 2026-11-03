/**
 * The plan status vocabulary, apart from the schema that carries it.
 *
 * `sessionTypes.ts` owns the persisted conversation shape and is already at the
 * 500-line gate, so the status words live here: this file knows nothing about
 * conversations, only about the three states a plan item can be in and the two
 * spellings models send for them.
 */
export const PLAN_STATUSES = ['pending', 'active', 'done'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/**
 * Statuses a model writes that mean a canonical one: accepted at the door and
 * stored as the canonical spelling.
 *
 * GLM-5.3 sent `in_progress` in two chats on 2026-11-02, and one of them paid
 * three refused calls before it found the word the schema wanted. A refusal that
 * costs a round and changes nothing about the plan is friction the tool can
 * simply not create. The list is two entries, not a synonym table: `doing`,
 * `ongoing` and `complete` still get the refusal that names the three, because a
 * word the model invented is a guess about which state it meant, and a ledger
 * that silently maps a guess is a ledger no reader can trust.
 *
 * The alias is repaired here rather than carried downstream, so `renderPlan`, the
 * webview, `isPlanFinished` and every saved record see only the three.
 */
export const PLAN_STATUS_ALIASES: Partial<Record<string, PlanStatus>> = {
  in_progress: 'active',
  completed: 'done',
};

/** Canonicalise an alias; pass anything else through for the enum to judge. */
export function canonicalPlanStatus(value: unknown): unknown {
  const alias = typeof value === 'string' ? PLAN_STATUS_ALIASES[value] : undefined;
  return alias ?? value;
}
