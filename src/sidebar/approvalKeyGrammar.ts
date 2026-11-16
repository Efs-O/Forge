/**
 * The approval-key grammar: what a path means, what a rule is allowed to say, and
 * whether a rule covers what a call needs.
 *
 * Split out of `approvalKey.ts` at the seam that was already there: one question
 * is "what does this call have to be allowed to do" (`approvalKeysFor`), the other
 * is "is this a key a chat may hold, and does it cover that requirement". They
 * change for different reasons — the first when a gate changes what it knows, the
 * second when the plan's key list or its folder exclusions change — and phase 4
 * (`policy.yaml`) consumes only this half, so a policy-rule loader can validate a
 * key string without building a fake tool call.
 *
 * Pure, like its parent: no `vscode`, no store, no config read. `~` forms come
 * from `secretPaths.ts` and the drive fold from `util/drivePath.ts` — the same two
 * helpers the secret gate and the owner-only wall use, so one file on disk is one
 * path to all three of them.
 */
import * as path from 'path';
import { expandUserTokens } from '../tools/secretPaths';
import { foldDrivePath, pathApiFor } from '../util/drivePath';

/** One key a call needs. `targets` is set only for `write:` and `rdelete:`: every
 *  target must lie inside the rule's folder for the rule to cover it. */
export interface ApprovalRequirement {
  key: string;
  targets?: readonly string[];
}

/** The environment the key rules need, injected so this file can answer for any
 *  window, any owner and any platform without reading a store or a config. */
export interface ApprovalKeyContext {
  platform: NodeJS.Platform;
  home: string;
  workspaceRoot: string | undefined;
  /** Owner-only roots (`ownerPaths.ts`), normalised absolute. */
  ownerOnly: readonly string[];
  /** `extra_file_roots`, absolute: the only outside folders the owner sanctioned. */
  extraFileRoots: readonly string[];
}

/** The prefixes a rule may use. `cross_chat` is a whole key, not a prefix. */
export const APPROVAL_KEY_PREFIXES = [
  'secret-net:',
  'net:',
  'net:prog:',
  'cross_chat',
  'delegate:',
  'write:',
  'secret:',
  'tool:',
  'rdelete:',
  'job-delete:',
] as const;

export const NET_KEY = 'net:';
export const SECRET_NET_KEY = 'secret-net:';
export const NET_PROG_KEY = 'net:prog:';
export const DELEGATE_KEY = 'delegate:';
export const WRITE_KEY = 'write:';
export const SECRET_KEY = 'secret:';
export const TOOL_KEY = 'tool:';
export const RDELETE_KEY = 'rdelete:';
export const JOB_DELETE_KEY = 'job-delete:';

/** `.forge` is Forge's own folder name; `~/.forge/` is the owner's folder, and a
 *  rule that reaches into it would let a chat approve a change to the guards the
 *  owner keeps there (`ownerPaths.ts` refuses the same write outright). */
const FORGE_DIR = '.forge';

// ── paths ─────────────────────────────────────────────────────────────────────

/** The path API of the OS being judged, so a Windows-shaped path is judged the way
 *  Windows judged it (`ownerPaths.ts` and `secretPaths.ts` apply the same rule). */
function apiFor(platform: NodeJS.Platform): path.PlatformPath {
  return pathApiFor(platform);
}

/**
 * Absolute, `~`/`$HOME`/`%USERPROFILE%` expanded, `..` collapsed, forward slashes,
 * no trailing separator except on a drive or OS root.
 *
 * Case is KEPT, because the key is the string the owner reads and the `gate` row
 * records; every comparison folds it where the file system does (`foldCase`).
 * `normalize` rather than `resolve`: `resolve` consults the process's current
 * folder and, on Windows, prepends the current drive to a drive-less path, so a
 * path written for another OS would come back wearing a drive it never had.
 */
export function keyPathOf(value: string, ctx: ApprovalKeyContext): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const api = apiFor(ctx.platform);
  const expanded = expandUserTokens(value, ctx.home);
  if (!api.isAbsolute(expanded)) return undefined;
  try {
    let out = api.normalize(expanded).replace(/\\/gu, '/');
    // Git Bash and MSYS spell a Windows drive as `/n/x`; the same file must be one
    // folder to this matcher and to the tool that opened it (`util/drivePath.ts`).
    out = foldDrivePath(out, ctx.platform)
      .replace(/\/{2,}/gu, '/')
      .replace(/\/+$/u, '');
    if (out.length === 0) return '/';
    return /^[a-z]:$/iu.test(out) ? `${out}/` : out;
  } catch {
    return undefined;
  }
}

/** Case-folded where the OS is case-insensitive, so a rule typed with a different
 *  case still names the folder the owner meant. */
export function foldCase(value: string, ctx: ApprovalKeyContext): string {
  return ctx.platform === 'win32' ? value.toLowerCase() : value;
}

/**
 * Is `child` equal to, or strictly inside, `folder`? The separator boundary is the
 * whole point: `D:/Down` does NOT cover `D:/Downloads`, and a prefix test without
 * one would let a rule for a short folder answer a delete in a longer folder next
 * to it.
 */
export function pathInsideFolder(child: string, folder: string, ctx: ApprovalKeyContext): boolean {
  const childPath = keyPathOf(child, ctx);
  const folderPath = keyPathOf(folder, ctx);
  if (!childPath || !folderPath) return false;
  const childFolded = foldCase(childPath, ctx);
  const folderFolded = foldCase(folderPath, ctx);
  return (
    childFolded === folderFolded ||
    childFolded.startsWith(folderFolded.endsWith('/') ? folderFolded : `${folderFolded}/`)
  );
}

/**
 * Is `child` STRICTLY inside `folder` — inside it, and not the folder itself?
 *
 * A `rdelete:` rule names the folder a chat may delete INSIDE, so the folder the
 * owner typed is the boundary and never another victim: a rule for `D:/build`
 * answers `rm -rf D:/build/cache` and not `rm -rf D:/build` itself. `write:`
 * keeps the equal case, because a write to the root the owner listed in
 * `extra_file_roots` is exactly what listing it meant.
 */
export function pathStrictlyInsideFolder(
  child: string,
  folder: string,
  ctx: ApprovalKeyContext,
): boolean {
  const childPath = keyPathOf(child, ctx);
  const folderPath = keyPathOf(folder, ctx);
  if (!childPath || !folderPath) return false;
  return (
    foldCase(childPath, ctx) !== foldCase(folderPath, ctx) && pathInsideFolder(child, folder, ctx)
  );
}

/**
 * The narrowest folder that contains every path, which is the folder the card
 * names: for one target its parent, for several their shared parent.
 *
 * Cut at a separator boundary, never at a run of shared characters: two siblings
 * under different folders share the characters `D:/Down` and have no folder in
 * common, so this returns the drive root, which `validateRuleKey` refuses for
 * `rdelete:` rather than inventing a folder nobody typed.
 */
export function commonFolderOf(
  paths: readonly string[],
  ctx: ApprovalKeyContext,
): string | undefined {
  const normalized: string[] = [];
  for (const value of paths) {
    const resolved = keyPathOf(value, ctx);
    if (!resolved) return undefined;
    normalized.push(resolved);
  }
  if (normalized.length === 0) return undefined;
  let prefix = normalized[0]!;
  for (const value of normalized.slice(1)) {
    let index = 0;
    while (index < prefix.length && index < value.length && prefix[index] === value[index])
      index += 1;
    const boundary = prefix.slice(0, index).lastIndexOf('/');
    if (boundary < 0) return undefined; // different drives, or no folder in common
    prefix = prefix.slice(0, boundary);
  }
  // The last segment is a target, not the folder that holds all of them.
  const parent = prefix.lastIndexOf('/');
  if (parent < 0) return undefined;
  const folder = prefix.slice(0, parent);
  if (folder.length === 0) return '/';
  return /^[a-z]:$/iu.test(folder) ? `${folder}/` : folder;
}

/** The narrowest `extra_file_roots` entry that holds every path: the owner
 *  sanctioned that folder, so it is the folder the key should name. Narrowest,
 *  because a key wider than the folder the owner listed would let a chat rule
 *  reach past what the owner put in the config. */
export function sanctionedRootFor(
  paths: readonly string[],
  ctx: ApprovalKeyContext,
): string | undefined {
  let best: string | undefined;
  for (const raw of ctx.extraFileRoots) {
    const root = keyPathOf(raw, ctx);
    if (!root) continue;
    if (!paths.every((value) => pathInsideFolder(value, root, ctx))) continue;
    if (best === undefined || root.length < best.length) best = root;
  }
  return best;
}

/** A host, or a program name: no separators, no spaces, no wildcards. A key built
 *  from a run-time value is checked here too, so `net:` can never become a glob. */
function hostOrProgramProblem(value: string, label: string): string | undefined {
  if (value.length === 0) return `${label} names nothing`;
  if (!/^[a-z0-9._-]+$/iu.test(value)) return `${label} must be one name without a separator`;
  return undefined;
}

/** `C:/` and `D:/` on any platform, `/` on a POSIX one: a folder rule this wide
 *  would approve deleting a whole disk. */
function isDriveOrOsRoot(value: string): boolean {
  return value === '/' || /^[a-z]:\/$/iu.test(value);
}

/**
 * The folders a `rdelete:` rule may never name, nor sit ABOVE: the owner's
 * profile, Forge's own state folder, every owner-only root, the workspace this
 * chat is working in, and the Windows folders the OS and the apps live in.
 *
 * Everything that answers a card depends on these folders still being there — the
 * guards under `~/.forge/`, the config, the session the owner is reading. A rule
 * that NAMES one of them, or that names a folder CONTAINING one of them, would let
 * a chat approve deleting the ground the guards and the work itself stand on:
 * `rdelete:C:/Users` with the profile at `C:/Users/<name>` deletes the whole
 * user profile, `.forge` included, and `rdelete:D:/projects` deletes the
 * workspace through its parent. That is why the check runs in both directions —
 * "is this folder inside a root" alone never notices an ancestor of one.
 *
 * One list, shared by `validateRuleKey` (the rule side) and `requirementProblem`
 * in `approvalKey.ts` (the target side), so the two halves cannot disagree. A
 * Windows-shaped name is not a path on a POSIX platform, so `C:/Windows` drops out
 * of the list there instead of becoming a folder nobody typed.
 */
export function protectedFolders(ctx: ApprovalKeyContext): readonly string[] {
  const names = [
    ctx.home,
    `${ctx.home}/${FORGE_DIR}`,
    ...ctx.ownerOnly,
    ...(ctx.workspaceRoot === undefined ? [] : [ctx.workspaceRoot]),
    'C:/Windows',
    'C:/Program Files',
    'C:/Program Files (x86)',
  ];
  const out: string[] = [];
  for (const name of names) {
    const resolved = keyPathOf(name, ctx);
    if (!resolved) continue;
    if (out.some((seen) => foldCase(seen, ctx) === foldCase(resolved, ctx))) continue;
    out.push(resolved);
  }
  return out;
}

/** Is `folder` one of those protected folders, or a folder that CONTAINS one of
 *  them? Returns the protected folder it holds — the name to put in the reason a
 *  call has no key — or undefined. Equal-to counts, so `rdelete:C:/Users/someone`
 *  is refused as the profile itself and `rdelete:C:/Users` is refused for holding
 *  it. A folder strictly inside one of them is the other direction, and stays fine:
 *  `rdelete:<workspace>/build` is exactly what a chat should be allowed to say. */
export function holdsProtectedFolder(folder: string, ctx: ApprovalKeyContext): string | undefined {
  const resolved = keyPathOf(folder, ctx);
  if (!resolved) return undefined;
  for (const guarded of protectedFolders(ctx)) {
    if (pathInsideFolder(guarded, resolved, ctx)) return guarded;
  }
  return undefined;
}

/**
 * Is this a key a chat may hold (and, in phase 4, `policy.yaml` may list)? Returns
 * the one-line reason it is not, naming the rule that refused it, or undefined.
 *
 * The exclusions are the plan §2 list, and they are what makes a rule that may be
 * typed safe to answer with: a drive root, the user-profile root, `C:/Windows` and
 * below, `C:/Program Files*` and below, the workspace root itself, and anything
 * under `~/.forge/` or under an owner-only root. `rdelete:` carries the wide list
 * because a recursive delete is the one key that can destroy a folder it did not
 * name, and it is checked in BOTH directions: a rule may neither name a protected
 * folder nor a folder that CONTAINS one (`protectedFolders`), so `rdelete:C:/Users`
 * is refused for taking the profile and `~/.forge` with it; `write:` and `secret:`
 * carry only the walls, because a write to a folder the owner did not list in
 * `extra_file_roots` is refused by the workspace rule before any key is consulted.
 */
export function validateRuleKey(key: string, ctx: ApprovalKeyContext): string | undefined {
  const value = key.trim();
  if (value.length === 0) return 'an approval rule must name something';
  if (value === 'cross_chat') return undefined;

  const colon = value.indexOf(':');
  if (colon < 0) {
    return `${value} is not an approval key (expected one of ${APPROVAL_KEY_PREFIXES.join(', ')})`;
  }
  const head = value.slice(0, colon + 1);
  const rest = value.slice(colon + 1);

  switch (head) {
    case SECRET_NET_KEY:
      return hostOrProgramProblem(rest, 'a secret-net: rule');
    case NET_KEY:
      if (rest.startsWith('prog:')) return hostOrProgramProblem(rest.slice(5), 'a net:prog: rule');
      return hostOrProgramProblem(rest, 'a net: rule');
    case DELEGATE_KEY:
      return hostOrProgramProblem(rest, 'a delegate: rule');
    case TOOL_KEY:
      if (rest.length === 0) return 'a tool: rule names no tool';
      return /^[a-z0-9_]+$/u.test(rest) ? undefined : `a tool: rule must name a tool, not ${rest}`;
    case JOB_DELETE_KEY:
      if (rest.length === 0) return 'a job-delete: rule names no job';
      return /^[A-Za-z0-9._-]+$/u.test(rest)
        ? undefined
        : `a job-delete: rule must name a job id, not ${rest}`;
    case WRITE_KEY:
    case SECRET_KEY:
    case RDELETE_KEY: {
      const folder = keyPathOf(rest, ctx);
      if (!folder) return `${value} needs an absolute path`;
      if (ctx.ownerOnly.some((root) => pathInsideFolder(folder, root, ctx))) {
        return `${value} reaches inside Forge's own files, which only the owner may change`;
      }
      const forgeFolder = keyPathOf(`${ctx.home}/${FORGE_DIR}`, ctx);
      if (forgeFolder && pathInsideFolder(folder, forgeFolder, ctx)) {
        return `${value} reaches inside ~/.forge/, which only the owner may change`;
      }
      if (head !== RDELETE_KEY) return undefined;
      if (isDriveOrOsRoot(folder)) {
        return `${value} is a disk root, not a folder to delete inside`;
      }
      for (const forbidden of ['C:/Windows', 'C:/Program Files', 'C:/Program Files (x86)']) {
        if (pathInsideFolder(folder, forbidden, ctx)) {
          return `${value} is inside ${forbidden}, which a chat rule may not delete under`;
        }
      }
      // The other direction, and the one that was missing: a rule that IS a
      // protected folder, or sits above one, deletes the guards along with it.
      const guarded = holdsProtectedFolder(folder, ctx);
      if (guarded) {
        return foldCase(folder, ctx) === foldCase(guarded, ctx)
          ? `${value} is ${guarded} itself, which a chat rule must not delete`
          : `${value} contains ${guarded}, which a chat rule must not delete`;
      }
      return undefined;
    }
    default:
      return `unknown approval key prefix (${head}) in ${value}; expected one of ${APPROVAL_KEY_PREFIXES.join(', ')}`;
  }
}

/** Exact string match for every key shape that is not a folder. Hosts, program
 *  names and delegation targets are compared case-insensitively (DNS and Windows
 *  both are); tool names and `cross_chat` exactly. */
function sameExactKey(rule: string, need: string, ctx: ApprovalKeyContext): boolean {
  const foldable =
    need.startsWith(NET_KEY) || need.startsWith(SECRET_NET_KEY) || need.startsWith(DELEGATE_KEY);
  const a = foldable ? rule.toLowerCase() : rule;
  const b = foldable ? need.toLowerCase() : need;
  return foldCase(a, ctx) === foldCase(b, ctx);
}

/**
 * Does this rule cover this requirement?
 *
 * `write:` and `rdelete:` cover by folder: every target the call names must be
 * inside the rule's folder, so a rule for `D:/Downloads` answers a delete of
 * `D:/Downloads/build` and never one of `D:/Other` — and for `rdelete:` it must be
 * strictly inside, never the folder the owner named itself, so a rule cannot delete
 * the very boundary it draws. Every other key matches
 * exactly, because `net:prog:curl` says nothing about `net:prog:wget` and
 * `cross_chat` is already the whole of what the call does.
 *
 * A rule that fails `validateRuleKey` covers nothing, ever — including a rule a
 * later phase writes into `policy.yaml` by hand and gets wrong.
 */
export function ruleCovers(
  rule: string,
  req: ApprovalRequirement,
  ctx: ApprovalKeyContext,
): boolean {
  if (validateRuleKey(rule, ctx) !== undefined) return false;
  const need = req.key;
  const folderPrefix = need.startsWith(WRITE_KEY)
    ? WRITE_KEY
    : need.startsWith(RDELETE_KEY)
      ? RDELETE_KEY
      : undefined;
  if (folderPrefix === undefined) {
    // A requirement that carries targets is a folder statement, and a rule that is
    // not a folder key cannot be checked against them: it does not cover it.
    if (req.targets !== undefined && req.targets.length > 0) return false;
    return sameExactKey(rule.trim(), need, ctx);
  }
  const targets = req.targets ?? [];
  if (targets.length === 0) return false;
  const ruleFolder = keyPathOf(rule.trim().slice(folderPrefix.length), ctx);
  if (!ruleFolder) return false;
  return targets.every((target) =>
    folderPrefix === RDELETE_KEY
      ? pathStrictlyInsideFolder(target, ruleFolder, ctx)
      : pathInsideFolder(target, ruleFolder, ctx),
  );
}
