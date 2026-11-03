import { baseProgram } from './shellCommandTokens';
import { tokenPathCandidate } from './secretPaths';

/**
 * Which argument positions a command is NOT writing to.
 *
 * Split out of `ownerPaths.ts` because it is a question about command argument
 * semantics, not about owner-only roots: the tables below say what `bash`,
 * `python`, `node`, `cp` and `Copy-Item` do with each positional, and the
 * owner-only guard then asks the one question it has — is any judged position
 * inside a root it protects. `shellReadOnlyRules.ts` cannot answer this: `isReadOnly`
 * is one yes/no for the whole statement and also decides whether a card is raised,
 * and `cp` is not read-only — it writes, just not at these positions.
 *
 * Kept as a pure function of the token list, so the same walk serves the owner-only
 * guard and any later gate that needs to know which positions a command changes.
 */
/**
 * Interpreters whose first non-flag argument is the file they run, not a file
 * they write: `python ~/.forge/skills/hf-download/scripts/hf_parallel_dl.py` is
 * the documented download path, not a rewrite of Forge's own files.
 */
const INTERPRETERS = new Set(['python', 'python3', 'py', 'node']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const PYTHON_CODE_FLAGS = new Set(['-c']);
const NODE_CODE_FLAGS = new Set(['-e', '-c', '--eval', '--print', '-p']);
/**
 * Programs that read their sources and write only their destination.
 * `mv`, `Move-Item`, `rsync`, `robocopy` and `ln` are deliberately absent: a
 * move source is deleted, so a move source IS a change and stays judged.
 */
const COPY_PROGRAMS = new Set(['cp', 'copy', 'copy-item']);
const COPY_TARGET_VALUE_FLAGS = new Set(['-t', '--target-directory']);
const CMDLET_SOURCE_FLAGS = new Set(['-p', '-path', '-literalpath', '-lp', '-source']);
const CMDLET_TARGET_FLAGS = new Set(['-d', '-destination', '-destinationpath']);
/** `--target-directory=X` and `-Destination:X` name the destination inline. */
const CP_INLINE_TARGET = /^(?:--target-directory|-t)[-=:](.+)$/iu;
const CMDLET_INLINE_TARGET = /^(?:-d|-destination|-destinationpath)[-=:](.+)$/iu;
/**
 * A short `cp` cluster that hides `t` or `s` (`-rt`, `-S .bak`), or a `--suffix`,
 * lets GNU `cp` reorder its arguments, so no position can be called a source.
 * Tokens arrive lowercased; a cluster that merely contains one is refused rather
 * than guessed at — the fail-closed side of this rule.
 */
const CP_REORDER_CLUSTER = /[ts]/u;

/** The positions a copy or an interpreter call is not writing to. */
export interface NonWritePositions {
  /** Indices holding code to run, or a source being read. */
  readonly skip: ReadonlySet<number>;
  /** Token index → the destination text written inline inside it. */
  readonly forcedTargets: ReadonlyMap<number, string>;
}

/**
 * The argument positions that are NOT a file this command writes, so a path
 * sitting in one of them is not a change to Forge's own files.
 *
 * Two kinds of position, because they are two different mistakes:
 * - Code to execute. `bash script.sh`, `pwsh -File script.ps1` and the
 *   interpreters above name a file to run, not a file to change: the token is
 *   the program's own source, and the token after `-c` or `-m` is code or a
 *   module name for the same reason. What the run itself does to a file is the
 *   run-time gap this file's header already accepts — a token matcher cannot see
 *   inside a script, so a skill that writes into `~/.forge/` still runs.
 * - The source side of a copy. `cp` and `Copy-Item` write only their
 *   destination, so `cp ~/.forge/skills/x.py N:/models/tools/` copies out of
 *   Forge's files without changing them.
 *
 * The copy rule fails CLOSED: a position is skipped only when the argument shape
 * is one this function is sure about, because a skipped position that was really
 * the destination lets a write to Forge's own files through, which is worse than
 * the false positive it fixes. PowerShell binds `Path` at position 0 and
 * `Destination` at position 1, so the first positional is skipped only when no
 * flag named either side, and every `-name:value` form fails closed. GNU `cp`
 * may reorder its arguments under a cluster hiding `t` or `s` or a `--suffix`,
 * so then nothing is skipped; positionals are sources only under a plain `-t`.
 *
 * `baseProgram` is `shellCommandTokens.ts`'s — the same program name the rest of
 * the classifier reads — so `python.exe`, `PY.EXE` and a `.cmd` wrapper all
 * match. This is deliberately not in `shellReadOnlyRules.ts`: `isReadOnly` is one
 * yes/no for the whole statement and it also decides whether a command needs an
 * approval card, and `cp` is not read-only — it writes, just not at these
 * positions.
 */
export function nonWriteArguments(tokens: readonly string[]): NonWritePositions {
  const skip = new Set<number>();
  const forcedTargets = new Map<number, string>();
  const positions = { skip, forcedTargets };
  const program = baseProgram(tokens[0] ?? '');
  if (program === '&') {
    if (tokens.length > 1) skip.add(1);
    return positions;
  }
  if (SHELLS.has(program)) {
    firstScriptOrCodeArgument(tokens, skip, new Set(['-c']));
    return positions;
  }
  if (program === 'pwsh' || program === 'powershell') {
    const fileFlag = tokens.findIndex((token, index) => index > 0 && /^-(?:file|f)$/iu.test(token));
    if (fileFlag > 0 && fileFlag + 1 < tokens.length) skip.add(fileFlag + 1);
    return positions;
  }
  if (INTERPRETERS.has(program)) {
    firstScriptOrCodeArgument(
      tokens,
      skip,
      program === 'node' ? NODE_CODE_FLAGS : PYTHON_CODE_FLAGS,
    );
    return positions;
  }
  if (COPY_PROGRAMS.has(program)) {
    const cmdlet = program === 'copy' || program === 'copy-item';
    const positionals: number[] = [];
    let namedBySourceFlag = false;
    let namedByTargetFlag = false;
    let reorderRisk = false;
    for (let index = 1; index < tokens.length; index += 1) {
      const token = (tokens[index] ?? '').toLowerCase();
      const inline = (cmdlet ? CMDLET_INLINE_TARGET : CP_INLINE_TARGET).exec(token)?.[1];
      if (inline) {
        forcedTargets.set(index, tokenPathCandidate(inline));
        namedByTargetFlag = true;
        continue;
      }
      if (cmdlet && CMDLET_SOURCE_FLAGS.has(token)) {
        skip.add(index + 1); // its sources are read
        namedBySourceFlag = true;
        index += 1;
        continue;
      }
      if (cmdlet && CMDLET_TARGET_FLAGS.has(token)) {
        namedByTargetFlag = true;
        index += 1; // its value is the destination, so it stays judged
        continue;
      }
      if (!cmdlet && COPY_TARGET_VALUE_FLAGS.has(token)) {
        namedByTargetFlag = true;
        index += 1;
        continue;
      }
      if (cmdlet && /^-\w+[-=:]/u.test(token)) {
        // A name-value form (`-Path:X`, `-Filter:X`): source or switch cannot be
        // told apart here, so fail closed and judge every positional.
        namedBySourceFlag = true;
        continue;
      }
      if (!cmdlet && (token === '--suffix' || token.startsWith('--suffix='))) {
        reorderRisk = true;
        continue;
      }
      if (!cmdlet && token.length > 1 && token.startsWith('-') && CP_REORDER_CLUSTER.test(token)) {
        reorderRisk = true; // `-rt`, `-a -S`: GNU cp may reorder its arguments
        continue;
      }
      if (token.startsWith('-')) continue;
      positionals.push(index);
    }
    // Fail closed: judge every positional unless the shape is settled.
    if (!reorderRisk && !namedBySourceFlag) {
      if (cmdlet) {
        if (namedByTargetFlag) return positions;
        if (positionals.length > 0) skip.add(positionals[0]); // Path at position 0
      } else if (namedByTargetFlag) {
        for (const index of positionals) skip.add(index); // the -t value is the target
      } else {
        for (const index of positionals.slice(0, -1)) skip.add(index);
      }
    }
    return positions;
  }
  return positions;
}

/**
 * The walk `bash` and `sh` already had, shared with `zsh`, `dash`, `python`,
 * `py` and `node`: skip flags, then the `-c` or `-m` argument (code, or a module
 * name), or the first non-flag token (the script to run). Everything after it is
 * still judged, so `python ~/.forge/skills/x.py --dest ~/.forge/out` is refused.
 */
function firstScriptOrCodeArgument(
  tokens: readonly string[],
  skip: Set<number>,
  codeFlags: ReadonlySet<string>,
): void {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = (tokens[index] ?? '').toLowerCase();
    if (codeFlags.has(token) || token === '-m') {
      skip.add(index + 1);
      return;
    }
    if (token === '--') {
      if (index + 1 < tokens.length) skip.add(index + 1);
      return;
    }
    if (token.startsWith('-')) continue;
    skip.add(index);
    return;
  }
}
