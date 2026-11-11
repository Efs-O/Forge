/**
 * The approval key: one string that says what a gated call actually does, so the
 * owner can answer that once instead of answering the same card again for every
 * call that does the same thing.
 *
 * Why this exists is a measured fact, not a preference. `gateEventLog.ts` was
 * added first because the weekend sweep over the session logs could not count a
 * single approval card (20,045 rows, none of them a card), and
 * `docs/plans/ASK_ONCE_APPROVALS_PLAN.md` §2 orders the card removals by that
 * cost. A key is what makes "ask once per thing, not once per call" possible: the
 * card, the chat rule and the `gate` row all name the same string, so an owner who
 * allows `rdelete:D:/Downloads` can see exactly what they allowed, and a later
 * reader can see exactly what answered.
 *
 * The two rules this file is built around, both from §2:
 *
 * - **A key never widens past what the card showed.** A path the gate could not
 *   read when it raised the card (built at run time, expanded by a glob, produced
 *   by a nested shell) has no key, so the call asks. Anything that cannot be
 *   checked is refused a key rather than given a guessed one: a key that was
 *   guessed wrong is an approval the owner never made.
 * - **The walls run before any key is looked up.** The owner-only wall
 *   (`ownerPaths.ts`) and the deny list's `refused` class are checked here even
 *   though the tool already refused those calls before this point, so a later
 *   phase that lets a key, Clanker or a policy rule reach past a wall has to
 *   notice it changed this file. `test/unit/ApprovalKeyWalls.test.ts` is the CI
 *   row that pins it.
 *
 * Everything is pure: no `vscode`, no store, no config read, no timer. The
 * environment (home, platform, workspace root, owner-only roots,
 * `extra_file_roots`) arrives in `ApprovalKeyContext`, so the table below is
 * testable without a window, and the same answers serve a chat rule (this phase)
 * and `policy.yaml` (phase 4) without a second copy of the rules. The path and
 * rule-grammar half lives in `approvalKeyGrammar.ts` and is re-exported here, so
 * every reader keeps one import path.
 */
import {
  DELEGATE_KEY,
  NET_KEY,
  RDELETE_KEY,
  SECRET_NET_KEY,
  TOOL_KEY,
  WRITE_KEY,
  commonFolderOf,
  holdsProtectedFolder,
  keyPathOf,
  pathInsideFolder,
  pathStrictlyInsideFolder,
  sanctionedRootFor,
  validateRuleKey,
  type ApprovalKeyContext,
  type ApprovalRequirement,
} from './approvalKeyGrammar';
import type { ExitKind } from './untrustedExitPolicy';

/** The rule grammar, re-exported so `chatApprovalRules.ts`, phase 4's policy
 *  loader and the tests all read the key rules through this one module. */
export {
  APPROVAL_KEY_PREFIXES,
  DELEGATE_KEY,
  NET_KEY,
  NET_PROG_KEY,
  RDELETE_KEY,
  SECRET_NET_KEY,
  SECRET_KEY,
  TOOL_KEY,
  WRITE_KEY,
  commonFolderOf,
  holdsProtectedFolder,
  keyPathOf,
  pathInsideFolder,
  pathStrictlyInsideFolder,
  protectedFolders,
  ruleCovers,
  sanctionedRootFor,
  validateRuleKey,
  type ApprovalKeyContext,
  type ApprovalRequirement,
} from './approvalKeyGrammar';

/** Either the keys the call needs (all must be covered), or why it has none and
 *  must always ask. A call is never part-keyed: half a key is not an approval. */
export type CallApprovalKeys =
  | { kind: 'keyed'; requirements: readonly ApprovalRequirement[] }
  | { kind: 'unkeyable'; why: string; ownerOnly?: true };

/** What `ToolDispatch` already worked out for `decideUntrustedExit`, plus the
 *  things only the gate that raised the card knows.
 *
 *  It deliberately does NOT carry the two chat flags: by the time this is asked
 *  the card has already been decided, and `exitGateKind` says whether the flag or
 *  a gate raised it. Re-reading the flags here would let a chat that changed state
 *  between the decision and the key lookup answer a card it was never raised for.
 */
export interface ApprovalKeyInput {
  toolName: string;
  /** The tool's own gate called this dangerous. */
  dangerous: boolean;
  /** The tool's own gate wants the owner to see this call (metadata that is not
   *  `cardTextOnly`). */
  toolGate: boolean;
  /** A mutation lands outside the workspace. */
  outsideWorkspace: boolean;
  /** The tool declared itself structurally bounded (`autoApprove`/`autoApproveIf`). */
  declaredSafe: boolean;
  /** Which way this call leaves the machine. */
  reachesOut: ExitKind;
  /** The gate that raised the card called it this kind. `denyList` is the deny
   *  list's own answer; a `taintGate` or `ownerGate` from a GATE gets no key here
   *  either, because those are the gates the plan says only the owner may settle. */
  approvalGateKind?: 'ownerGate' | 'taintGate' | 'denyList';
  /** The card rule's kind for the same card (`untrustedExitPolicy.ts`), asked
   *  separately because a gate's kind and the flag's kind are different facts and
   *  `requestApproval` collapses them into one. */
  exitGateKind?: 'ownerGate' | 'taintGate' | 'denyList';
  /** Set by the gate that knows the answer (`toolContract.ts`): `net:<host>`,
   *  `net:prog:<program>`, `secret:<file>`, `rdelete:<folder>`. */
  approvalKey?: string;
  /** The targets behind an `rdelete:` or `write:` key, resolved by that gate. */
  approvalTargets?: readonly string[];
  /** Every path this call would change, resolved. Checked against the walls. */
  mutationPaths?: readonly string[];
  /** The subset that lands outside the workspace: what a `write:` key must cover. */
  outsideMutationPaths?: readonly string[];
  /** The agent this call hands its task to, lower-cased (`ask_local_agent`'s
   *  `model`, `ask_agent`'s `agent`). Absent when the call names none. */
  delegateTarget?: string;
}

/** The two tools that hand a task to another model, and the argument that names
 *  which one. Kept here rather than in `ToolDispatch.ts` so the dispatch stays a
 *  lookup and the knowledge of tool shapes stays with the key rules.
 *
 *  `ask_agent` is declared `cross_chat`, so its key is `cross_chat` and this entry
 *  only matters for `delegation` exits; naming it anyway is what lets a later phase
 *  key a delegation by target for both tools without a new table. */
const DELEGATE_TARGET_ARGS: Readonly<Record<string, string>> = {
  ask_agent: 'agent',
  ask_local_agent: 'model',
};

/** The target agent this call names, lower-cased, or undefined when it names none
 *  (a missing or non-string argument, or a tool that is not a delegation). */
export function delegateTargetFor(
  toolName: string,
  args: Record<string, unknown>,
): string | undefined {
  const field = DELEGATE_TARGET_ARGS[toolName];
  if (!field) return undefined;
  const value = args[field];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

const unkeyable = (why: string, ownerOnly = false): CallApprovalKeys => ({
  kind: 'unkeyable',
  why,
  ...(ownerOnly ? { ownerOnly: true } : {}),
});

/** The first path this call touches that sits inside Forge's own files. Checked
 *  before any key is built, because the wall is not a key question: a rule for the
 *  right folder must not answer a call that touches Forge's own guards. */
function firstOwnerOnlyPath(input: ApprovalKeyInput, ctx: ApprovalKeyContext): string | undefined {
  const candidates: string[] = [
    ...(input.mutationPaths ?? []),
    ...(input.outsideMutationPaths ?? []),
    ...(input.approvalTargets ?? []),
  ];
  const key = input.approvalKey ?? '';
  for (const prefix of [WRITE_KEY, 'secret:', RDELETE_KEY]) {
    if (key.startsWith(prefix)) candidates.push(key.slice(prefix.length));
  }
  for (const raw of candidates) {
    const resolved = keyPathOf(raw, ctx);
    if (!resolved) continue;
    if (ctx.ownerOnly.some((root) => pathInsideFolder(resolved, root, ctx))) return resolved;
  }
  return undefined;
}

/** What is wrong with this requirement as a key, or undefined when it is a sound
 *  one: the key is something a chat may hold, and every target it claims to cover
 *  really is inside it. A `rdelete:` target must be STRICTLY inside the rule's
 *  folder, and must not itself hold a protected folder: a delete of
 *  `C:/Users/someone` is not answered by a rule for `C:/Users`, however wide that
 *  rule is, because it takes `~/.forge` and the session with it.
 *
 *  `ruleCovers` applies the same two checks to a rule a chat already holds, so a
 *  requirement that survives here is one a rule can honestly cover — and phase 4's
 *  `policy.yaml` loader reads this same function through `validateRuleKey`.
 */
function requirementProblem(req: ApprovalRequirement, ctx: ApprovalKeyContext): string | undefined {
  const invalid = validateRuleKey(req.key, ctx);
  if (invalid) return `the key this call needs cannot be allowed by a chat: ${invalid}`;
  const folderPrefix = req.key.startsWith(WRITE_KEY)
    ? WRITE_KEY
    : req.key.startsWith(RDELETE_KEY)
      ? RDELETE_KEY
      : undefined;
  if (folderPrefix === undefined) return undefined;
  const targets = req.targets ?? [];
  if (targets.length === 0) {
    return `the key ${req.key} names no target a folder rule could be checked against`;
  }
  const folder = keyPathOf(req.key.slice(req.key.indexOf(':') + 1), ctx);
  for (const target of targets) {
    const covered =
      folder &&
      (folderPrefix === RDELETE_KEY
        ? pathStrictlyInsideFolder(target, folder, ctx)
        : pathInsideFolder(target, folder, ctx));
    if (!covered) {
      return `a target this call touches (${target}) is outside the folder ${req.key} names`;
    }
    if (folderPrefix === RDELETE_KEY) {
      const guarded = holdsProtectedFolder(target, ctx);
      if (guarded) {
        return (
          `a target this call would delete (${target}) holds ${guarded}, which only the ` +
          'owner may delete'
        );
      }
    }
  }
  return undefined;
}

/**
 * The keys this call needs, in the plan §2 order.
 *
 * One pass, five rules: the walls first, then the deny list, then the flagged
 * exit, then the tool's own gate, then the write outside the workspace. Each rule
 * that applies contributes one requirement, and any part that has no key makes the
 * whole call `unkeyable` — a call is never half-keyed, because answering half a
 * card and running it would run the half nobody answered.
 */
export function approvalKeysFor(
  input: ApprovalKeyInput,
  ctx: ApprovalKeyContext,
): CallApprovalKeys {
  // 1. The walls, ahead of everything.
  const wall = firstOwnerOnlyPath(input, ctx);
  if (wall) {
    return unkeyable(
      `${wall} is inside Forge's own files, which only the owner may change: no key, ` +
        'no Clanker and no policy rule reaches past it.',
      true,
    );
  }

  const requirements: ApprovalRequirement[] = [];

  // 2. The deny list: no key, except a recursive delete whose targets it could read.
  const denyList = input.approvalGateKind === 'denyList' || input.exitGateKind === 'denyList';
  if (denyList) {
    const key = input.approvalKey ?? '';
    const targets = input.approvalTargets ?? [];
    if (!key.startsWith(RDELETE_KEY) || targets.length === 0) {
      return unkeyable(
        'the deny list calls this command dangerous and cannot name a folder for it, ' +
          'so it always asks the owner.',
      );
    }
    requirements.push({ key, targets });
  }

  // 3. A card the untrusted flag raised, and nothing else did: the way out is the key.
  if (!denyList && input.exitGateKind === 'taintGate') {
    if (input.reachesOut === 'network') {
      const key = input.approvalKey ?? '';
      if (!key.startsWith(NET_KEY) && !key.startsWith(SECRET_NET_KEY)) {
        return unkeyable(
          'this chat has taken in outside content, and this command reaches the network ' +
            'through more than one program or through a shell this matcher cannot read, ' +
            'so there is no single program to allow.',
        );
      }
      requirements.push({ key });
    } else if (input.reachesOut === 'cross_chat') {
      requirements.push({ key: 'cross_chat' });
    } else if (input.reachesOut === 'delegation') {
      const target = input.delegateTarget;
      if (!target) {
        return unkeyable(
          'this call hands its task to another model without naming which one, so there ' +
            'is no target to allow.',
        );
      }
      requirements.push({ key: `${DELEGATE_KEY}${target}` });
    } else {
      return unkeyable('this card was raised for a way out that has no key.');
    }
  }

  // 4. The tool's own gate: its own key if it set one, else a tool key only for a
  //    call that is not dangerous and has no gate kind of its own. A `denyList` call
  //    is skipped here because its key, if it has one, was already answered above —
  //    adding it twice would ask the owner to allow the same thing twice.
  if (input.toolGate && !denyList) {
    const key = input.approvalKey;
    if (key !== undefined && key.length > 0) {
      requirements.push({
        key,
        ...(input.approvalTargets && input.approvalTargets.length > 0
          ? { targets: input.approvalTargets }
          : {}),
      });
    } else if (!input.dangerous && input.approvalGateKind === undefined) {
      requirements.push({ key: `${TOOL_KEY}${input.toolName}` });
    } else {
      return unkeyable(
        'this gate called itself dangerous without naming the folder, host or file it is ' +
          'asking about, so it fails closed and asks the owner every time.',
      );
    }
  }

  // 5. A write outside the workspace: the folder the owner sanctioned, else the
  //    parent folder of the paths — the folder the card names.
  if (input.outsideWorkspace && !input.declaredSafe) {
    const paths = input.outsideMutationPaths ?? [];
    if (paths.length === 0) {
      return unkeyable('this call writes outside the workspace without naming a path.');
    }
    const root = sanctionedRootFor(paths, ctx) ?? commonFolderOf(paths, ctx);
    if (!root) {
      return unkeyable(
        'the paths this call writes have no single parent folder, so there is no folder ' +
          'a chat rule could name.',
      );
    }
    requirements.push({ key: `${WRITE_KEY}${root}`, targets: paths });
  }

  if (requirements.length === 0) {
    return unkeyable(
      'nothing in this call has a key the owner could allow, so it asks every time.',
    );
  }
  for (const req of requirements) {
    const problem = requirementProblem(req, ctx);
    if (problem) return unkeyable(problem);
  }
  // Deduped by key, so a call whose rules agree on one key is one requirement: the
  // owner is asked to allow one thing, and the `gate` row names one key.
  const unique = requirements.filter(
    (req, index) => requirements.findIndex((other) => other.key === req.key) === index,
  );
  return { kind: 'keyed', requirements: unique };
}

/** The keys a call needs, joined for the `approval_key` column of the `gate` row. */
export function approvalKeysText(requirements: readonly ApprovalRequirement[]): string {
  return requirements.map((req) => req.key).join(',');
}
