/**
 * The owner-only rule for a shell command line: which statement is refused, and
 * what the refusal says.
 *
 * Split out of `shellPolicy.ts` because the two questions are different ones.
 * `shellPolicy.ts` walks a whole command line — deny list, here-documents,
 * nested shells, the secret gate, network reach — and answers what class it
 * deserves. This file answers one narrower question with four possible answers:
 * does any part of this line touch Forge's own files, and if so, is it a change
 * to them, a write that only reaches them because a `cd` moved it, or nothing
 * that was ever classed as a change at all. A script argument is another fact:
 * nothing was seen writing the path, but a token check cannot judge what the
 * script does with it.
 *
 * The read-from-write decision is NOT here: `shellReadOnlyRules.ts` owns it, and
 * this file asks that table whether a statement reads. A second table of writing
 * programs would disagree with the first the next time either changed, and the
 * two answers would be used against each other.
 */
import * as os from 'os';
import { isDirectoryChange, isReadOnly } from './shellReadOnlyRules';
import {
  effectiveDirectoryFor,
  ownerOnlyInstruction,
  ownerOnlyStatementTargetFor,
  type OwnerOnlyHit,
  type OwnerOnlyRedirect,
  type OwnerOnlySet,
} from './ownerPaths';
import type { ShellTokenRule } from './DenyList';
import type { ShellKind } from './shellCommandTokens';

/** The set this window's guard judges with, or `undefined` when nothing supplies
 *  the roots — the state an unwired window gets, where the guard is inert and
 *  the classifications stay exactly what they always were. Built once per call
 *  so the redirect question and the statement question cannot disagree about
 *  which roots they were guarding.
 *
 *  Structurally typed on purpose: `shellPolicy.ts`'s `ShellSecretCheck` is the
 *  caller's shape, and importing it here would make the classifier and this file
 *  import each other for one type. */
export function ownerOnlySetForGuard(guard: {
  ownerOnly?: readonly string[];
  home?: string;
  platform?: NodeJS.Platform;
}): OwnerOnlySet | undefined {
  const roots = guard.ownerOnly;
  if (!roots || roots.length === 0) return undefined;
  return {
    roots,
    home: guard.home ?? os.homedir(),
    platform: guard.platform ?? process.platform,
  };
}

/**
 * Why a `cd` this table cannot follow is being refused, in the agent's words.
 * The three reasons are three different fixes, and a refusal that named none of
 * them would leave the agent guessing which one to try.
 */
function cdCannotFollowReason(tokens: readonly string[]): string {
  const dir = tokens[1] ?? '';
  if (/[$`()]/u.test(dir)) return 'the folder is built at run time';
  if (tokens.length > 2) return 'it names more than one folder';
  return 'it names no folder this check can resolve';
}

export interface OwnerOnlyShellRuleInput {
  /** The statements as the classifier walks them, in order. */
  statements: readonly (readonly string[])[];
  shell: ShellKind;
  /** The folder the command's relative paths resolve against — the shell tool's `cwd`. */
  cwd?: string;
  /** Whether `cd` may count as a read for this command (`shellReadOnlyRules.ts`). */
  cdReadonly: boolean;
  set: OwnerOnlySet;
  /** A `>` that lands inside an owner-only root, judged by `ownerPaths.ts`'s `firstOwnerOnlyRedirect`. */
  redirectHit?: OwnerOnlyRedirect;
}

/**
 * The rule that refuses a command writing, moving, deleting or redirecting onto
 * Forge's own files — `config.yaml` while its security settings are still inside
 * it, and everything under `~/.forge/`, which the agent could otherwise edit to
 * switch its own guards off.
 *
 * Four shapes, because they are four different facts, and each needs its own
 * sentence:
 * - a `>` or `>>` whose target is inside a root from the start:
 *   `echo x > .forge/config.yaml` runs `echo`, which the read-only table knows,
 *   and still overwrites the file. A `cat .forge/config.yaml > backup.txt` is
 *   the other mistake — reading the config and writing something else — and only
 *   the target is judged.
 * - a `>` that reaches a root only because a `cd` earlier in the line moved it:
 *   `cd ~/.forge/sessions && ls > notes.txt`. Still a change, but the `cd` is
 *   what did it, and a refusal that named only the folder would leave the agent
 *   re-running the `cd` with a different reader and the same relative target.
 * - a statement the read-only table does not class as a read, following a `cd`
 *   into a root: `cd ~/.forge && rm x`. The `cd` is not the write, and the guard
 *   cannot say where the write lands, so the whole line is refused and the words
 *   name both parts.
 * - a `cd` into a root with nothing else in the line classed as a change:
 *   `cd ~/.forge/$d && ls`. Nothing here was refused for writing, and saying so
 *   would be a lie the agent cannot act on, so the refusal says what it actually
 *   cannot do — follow a folder it cannot resolve.
 *
 * Whole tokens, resolved against the command's cwd, never a substring: a commit
 * message or a longer file name that merely contains `.forge/config.yaml` is not
 * a write to it.
 */
export function ownerOnlyShellRule(input: OwnerOnlyShellRuleInput): ShellTokenRule | undefined {
  const { statements, shell, cwd, cdReadonly, set, redirectHit } = input;
  /** A statement the read-only table classed as a write, or a `>` whose target
   *  is inside a root from the start: the command IS changing that path, so
   *  "refuses to change" is what happened, and the refusal says it. */
  const ruleFor = (hit: OwnerOnlyHit): ShellTokenRule =>
    hit.scriptToken
      ? {
          match: () => true,
          description: `cannot tell whether \`${hit.scriptToken}\` changes Forge's own files (${hit.supplied})`,
          alternative:
            "Nothing was seen writing that file, but what a script does with its arguments cannot be judged, so a path inside Forge's own files passed to a script is treated as a change. To give the script the file, copy it out first with `cp <path> <a folder in the workspace>` (a copy source is not a change) and pass the copy. " +
            ownerOnlyInstruction(),
          class: 'refused',
          gateKind: 'ownerGate',
        }
      : {
          match: () => true,
          description: `refuses to change Forge's own files (${hit.supplied})`,
          alternative: ownerOnlyInstruction(),
          class: 'refused',
          gateKind: 'ownerGate',
        };
  /** A `>` that only lands inside Forge's own files because a `cd` earlier in
   *  the line moved it. It is still a change, so the words say change — and say
   *  which part of the line did it, because the `cd` alone looks harmless. */
  const cdRedirectRuleFor = (hit: OwnerOnlyHit, target: string): ShellTokenRule => ({
    match: () => true,
    description:
      `refuses to change Forge's own files (${hit.target}): the \`cd\` earlier in this ` +
      `line moves \`> ${target}\` inside them`,
    alternative:
      `The \`> ${target}\` is relative, so it is written in the folder the \`cd\` moved to, ` +
      'not the folder the command started in. Give the `>` an absolute path, or leave the ' +
      '`cd` out and pass that folder as the shell tool `cwd` argument — the shell tool does ' +
      'not keep a working directory between calls, so a `cwd` is a folder this guard can ' +
      `judge. ${ownerOnlyInstruction()}`,
    class: 'refused',
    gateKind: 'ownerGate',
  });
  /** A `cd` this table cannot follow, with NOTHING in the command classed as a
   *  change. Saying "refuses to change" here would tell the agent it had tried
   *  to write a file it never touched — the misreading that made a session-log
   *  read look like a refused write in the 11-02 live test. */
  const cdUnjudgeableRuleFor = (tokens: readonly string[]): ShellTokenRule => ({
    match: () => true,
    description:
      `cannot judge \`cd ${tokens[1] ?? ''}\` into Forge's own files ` +
      `(${cdCannotFollowReason(tokens)})`,
    alternative:
      'Nothing in this command was classed as a change, so this is not a refusal to write ' +
      'that folder: the guard cannot follow a `cd` whose folder it cannot resolve, and a `cd` ' +
      'it cannot see would move every later relative path in this same line. Spell the folder ' +
      'in full, or read it with `read_file` / `grep_search`. ' +
      `${ownerOnlyInstruction()}`,
    class: 'refused',
    gateKind: 'ownerGate',
  });
  /** A `cd` refused because something later in the same command writes needs its
   *  own words, naming both: the agent has to see that the `cd` was not the
   *  problem and that the guard cannot follow a relative write into the new
   *  directory, so guessing where it lands is not an answer it can act on. */
  const cdRuleFor = (dir: readonly string[], later: readonly string[]): ShellTokenRule => ({
    match: () => true,
    description:
      `\`cd ${dir[1] ?? ''}\` into Forge's own files, followed by something the read-only ` +
      `table does not class as a read (\`${later.join(' ')}\`)`,
    alternative:
      'Forge cannot tell where a write after a `cd` lands, so the whole command is ' +
      'refused: the write is judged against the folder the command started in, not ' +
      'the one the `cd` moved to. Use an absolute path, or pass that folder as the ' +
      'shell tool `cwd` argument instead of `cd` — the shell tool does not keep a ' +
      'working directory between calls, so `cd` in one call and the write in the ' +
      'next runs the write where the first call started, not where the `cd` went.',
    class: 'refused',
    gateKind: 'ownerGate',
  });
  /** A write that reaches Forge's own files only because a `cd` earlier in the
   *  line moved it there. */
  const cdMovedRuleFor = (hit: OwnerOnlyHit, statement: readonly string[]): ShellTokenRule => ({
    match: () => true,
    description:
      `refuses to change Forge's own files (${hit.target}): the \`cd\` earlier in this ` +
      `line moves \`${statement.join(' ')}\` inside them`,
    alternative: ownerOnlyInstruction(),
    class: 'refused',
    gateKind: 'ownerGate',
  });
  /** A write after a `cd` this check cannot follow, naming a path whose last
   *  parts match one of Forge's own roots: where it lands cannot be known, and
   *  one of the places it could land is the policy file. */
  const cdUnfollowableWriteRuleFor = (statement: readonly string[]): ShellTokenRule => ({
    match: () => true,
    description:
      `cannot judge \`${statement.join(' ')}\`: it follows a \`cd\` this check cannot ` +
      "follow, and it names a path that may be Forge's own files",
    alternative:
      'Spell the `cd` folder in full, or give the write an absolute path, so the guard can ' +
      `see where it lands. ${ownerOnlyInstruction()}`,
    class: 'refused',
    gateKind: 'ownerGate',
  });
  if (redirectHit) {
    return redirectHit.viaCd
      ? cdRedirectRuleFor(redirectHit.hit, redirectHit.target)
      : ruleFor(redirectHit.hit);
  }
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index]!;
    if (isReadOnly(statement, shell, cdReadonly)) continue;
    const hit = ownerOnlyStatementTargetFor(statement, set, cwd);
    if (!hit) {
      // Judged from the start folder, `cd ~ && cp x .forge/policy.yaml` names
      // `<workspace>/.forge/policy.yaml` and passes, while the shell writes the
      // real one. So the write is judged again from the folder the `cd`s moved to.
      const moved = movedStatementHit(statements, index, set, cwd);
      if (moved === 'unfollowable') return cdUnfollowableWriteRuleFor(statement);
      if (moved) return cdMovedRuleFor(moved, statement);
      continue;
    }
    if (isDirectoryChange(statement)) {
      const laterWrite = statements
        .slice(index + 1)
        .find((other) => !isReadOnly(other, shell, false));
      if (laterWrite) return cdRuleFor(statement, laterWrite);
      return cdUnjudgeableRuleFor(statement);
    }
    return ruleFor(hit);
  }
  return undefined;
}

/**
 * The owner-only target a statement names when judged from the folder the `cd`s
 * before it moved to; `'unfollowable'` when a `cd` before it cannot be followed
 * and the statement names a path whose trailing parts match a root's trailing
 * parts (`.forge/policy.yaml`, `.forge`, `config.yaml`) — the one case where
 * not knowing the folder could mean writing Forge's own files.
 */
function movedStatementHit(
  statements: readonly (readonly string[])[],
  index: number,
  set: OwnerOnlySet,
  cwd: string | undefined,
): OwnerOnlyHit | 'unfollowable' | undefined {
  if (!statements.slice(0, index).some(isDirectoryChange)) return undefined;
  const moved = effectiveDirectoryFor(statements, index, set, cwd);
  if (moved) return ownerOnlyStatementTargetFor(statements[index]!, set, moved);
  return statements[index]!.slice(1).some((token) => namesRootTail(token, set))
    ? 'unfollowable'
    : undefined;
}

/** Does this relative token end in the last part of an owner-only root, or pass
 *  through one (`.forge/x`)? Whole path segments only, never a substring. */
function namesRootTail(token: string, set: OwnerOnlySet): boolean {
  const fold = (value: string): string => (set.platform === 'win32' ? value.toLowerCase() : value);
  const partsOf = (value: string): string[] =>
    fold(value).replace(/\\/gu, '/').split('/').filter(Boolean);
  const tails = set.roots.map((root) => partsOf(root).pop() ?? '');
  return partsOf(token).some((segment) => tails.includes(segment));
}
