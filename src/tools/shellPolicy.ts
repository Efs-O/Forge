import * as os from 'os';
import { getBuiltinDenyList, rdeleteTargetsFor, type ShellTokenRule } from './DenyList';
import { extractHeredocs, feedsHeredocToShell, openHeredocRule } from './shellHeredoc';
import { baseProgram, type ShellKind } from './shellCommandTokens';
import { parseCommand } from './shellCommandParse';
import { commandIsAllReadOnly, isReadOnly, pipeTargetReadsContents } from './shellReadOnlyRules';
import {
  executableStatements,
  expandLiteralBashAssignments,
  extractCommandStrings,
  isPurePwshExpression,
} from './shellCommandStrings';
import { argumentLooksComputed, secretDeclineHint } from './secretPaths';
import { secretReadInStatements } from './shellSecretReads';
import { statementNetworkProgram } from './shellNetworkPrograms';
import { firstOwnerOnlyRedirect } from './ownerPaths';
import { commonFolderOf } from '../sidebar/approvalKeyGrammar';
import { ownerOnlySetForGuard, ownerOnlyShellRule } from './shellOwnerRule';
import { commandStartsElevation, scriptNestedCommands } from './shellScriptFiles';
import type { ForgeConfig } from '../config/types';

type ShellClass = 'read_only' | 'normal' | 'dangerous' | 'refused';

/** What the gates need to judge a command: the config's extra secret patterns,
 *  the home folder `~` expands against, the folder the command's relative paths
 *  resolve against, and the owner-only roots (injectable throughout, so tests do
 *  not depend on who is logged in or on which window loaded which config). */
export interface ShellSecretCheck {
  getConfig?: () => ForgeConfig;
  home?: string;
  platform?: NodeJS.Platform;
  /** The shell tool's cwd. Without it a relative token cannot be judged, and
   *  only absolute paths in the command are checked — which is what a window
   *  with no folder open gets. */
  cwd?: string;
  /** The normalised absolute roots an agent may not change (`ownerPaths.ts`).
   *  Absent or empty: the owner guard is inert, so a wiring that never supplies
   *  it keeps the classifications it always had. */
  ownerOnly?: readonly string[];
  /** Injectable script reader so classification tests do not need filesystem fixtures. */
  readScript?: (absPath: string) => string | { error: string };
}

export interface ShellClassification {
  classification: ShellClass;
  rule?: ShellTokenRule;
  elevatedProcess?: boolean;
  /** The secret path this command reads even though the owner put that exact
   *  path in `permissions.secret_paths_allow`: the allow list may skip the card,
   *  never the chat's taint, so the tool marks the chat from this field. */
  readSecretIgnoringAllowList?: string;
  /**
   * True when something in this command reaches a host outside this machine:
   * `curl`, `wget`, `Invoke-WebRequest`, `ssh`, `scp`, a `git push`, a package
   * install or publish. Additive — it never changes the classification, only
   * what the card rule does with it: `src/sidebar/untrustedExitPolicy.ts` puts a
   * card on a network-reaching command only in a chat that has outside content
   * or a secret in it, and lets a clean chat run it asking nothing, because a
   * clean chat has nothing there for an outside page to have chosen to send.
   */
  networkReaching?: boolean;
  /**
   * The one program this command reaches a host through, when there is exactly one
   * and it did not reach there through a nested shell: `curl`, `git-push`,
   * `npm-install`. Set alongside `networkReaching` and read only to build the key
   * `net:prog:<program>` (`shellTool.ts`), which is what lets a chat that has taken
   * in outside content be asked once about `curl` instead of once about every
   * command that runs `curl`.
   *
   * Two programs in one command (`curl x && npm install y`), or a network-reaching
   * block inside `$(…)`, `\`…\``, an `iex` string or a here-doc a shell reads, and
   * this stays unset: the card would name a program the owner cannot see the whole
   * of, and a key that only covers half a card is a card half-answered.
   */
  networkProgram?: string;
  /** The approval key this call's own gate knows: `rdelete:<folder>` for a
   *  recursive delete whose targets can be read out of the command, `secret:<file>`
   *  for a read of one file this matcher can locate. Set only when the gate knows
   *  the answer, and read only by `approvalKey.ts`; a dangerous call whose gate names
   *  nothing gets no key and asks every time.
   */
  approvalKey?: string;
  /** The resolved targets behind an `rdelete:` key. Every one must lie inside the
   *  key's folder, or the key is wider than the card and `approvalKeysFor` refuses
   *  it rather than trusting the gate that made it.
   */
  approvalTargets?: readonly string[];
}

function precedence(classification: ShellClass): number {
  return { read_only: 0, normal: 1, dangerous: 2, refused: 3 }[classification];
}

function findBalanced(
  source: string,
  start: number,
  open: string,
  close: string,
  shell: ShellKind,
): { value: string; end: number } | undefined {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index] ?? '';
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (shell === 'bash' && char === '\\') escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === open) depth += 1;
    if (char === close && --depth === 0)
      return { value: source.slice(start + 1, index), end: index };
  }
  return undefined;
}

function nestedShellCommands(command: string, shell: ShellKind): string[] {
  const nested: string[] = [];
  let quote: string | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? '';
    const next = command[index + 1] ?? '';
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === '$' && next === '(') {
      // `"$(...)"` still runs its command in both shells.
      const block = findBalanced(command, index + 1, '(', ')', shell);
      if (block) (nested.push(block.value), (index = block.end));
      continue;
    }
    if (shell === 'bash' && char === '`' && quote !== "'") {
      const end = command.indexOf('`', index + 1);
      if (end > index) (nested.push(command.slice(index + 1, end)), (index = end));
      continue;
    }
    if (quote) {
      if (shell === 'bash' && char === '\\') escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    // bash: `${VAR}` and `{a,b}` expand words; only `{ cmd; }` groups commands.
    if (shell === 'bash' && char === '{' && !/\s/u.test(next)) continue;
    let opener = char;
    let offset = index;
    if (shell !== 'bash' && char === '$' && next === '(') {
      opener = '(';
      offset = index + 1;
    } else if (shell !== 'bash' && char === '`' && next === '(') {
      opener = '(';
      offset = index + 1;
    }
    if (opener === '{' || opener === '(') {
      const block = findBalanced(command, offset, opener, opener === '{' ? '}' : ')', shell);
      if (block) {
        nested.push(block.value);
        index = block.end;
      }
    }
  }
  return nested;
}

export function classifyShellCommand(
  command: string,
  shell: ShellKind,
  check: ShellSecretCheck = {},
): ShellClassification {
  return classifyShellCommandAtDepth(command, shell, check, 0, new Set());
}

function classifyShellCommandAtDepth(
  command: string,
  shell: ShellKind,
  check: ShellSecretCheck,
  scriptDepth: number,
  scriptPaths: ReadonlySet<string>,
): ShellClassification {
  // A here-document body is stdin, not commands, unless a shell reads it or bash expands `$(` in it.
  const heredocs = extractHeredocs(command, shell);
  // `<<'PY` with the quote never closed is bash's own parse error, refused here
  // so no rule below can mistake a path in the body for a write to Forge's files.
  if (heredocs.unterminated)
    return { classification: 'refused', rule: openHeredocRule(heredocs.unterminated) };
  command = heredocs.command;
  const parsed = parseCommand(command, shell);
  const sourceStatements =
    shell === 'bash' ? expandLiteralBashAssignments(parsed.statements) : parsed.statements;
  const statements = executableStatements(sourceStatements);
  const rules = getBuiltinDenyList();
  /**
   * The two facts `commonFolderOf` needs to name the folder a recursive delete sits
   * in. The rest of the key context — the owner-only roots, `extra_file_roots`, the
   * workspace root — belongs to the window, not to a command, and it arrives in
   * `approvalKeysFor`, which is where every key this file proposes is finally
   * validated. So this file resolves the folder and that function decides whether a
   * chat may be asked to allow it.
   */
  const folderContext = {
    platform: check.platform ?? process.platform,
    home: check.home ?? os.homedir(),
    workspaceRoot: undefined,
    ownerOnly: [] as readonly string[],
    extraFileRoots: [] as readonly string[],
  };
  const downloaders = new Set(['curl', 'wget', 'iwr', 'invoke-webrequest']);
  const shellPrograms = new Set(['sh', 'bash', 'iex', 'invoke-expression']);
  const downloadPipe = parsed.separators.some(
    (separator, index) =>
      separator === 'pipe' &&
      downloaders.has(baseProgram(parsed.statements[index]?.[0] ?? '')) &&
      shellPrograms.has(baseProgram(parsed.statements[index + 1]?.[0] ?? '')),
  );
  if (downloadPipe) {
    const rule = rules.find(
      (candidate) =>
        candidate.class === 'refused' && candidate.description === 'download piped to a shell',
    );
    if (rule) return { classification: 'refused', rule };
  }
  let strongest: ShellClassification = { classification: 'read_only' };
  let elevationSeen = commandStartsElevation(command, shell, check.platform ?? process.platform);
  let networkSeen = false;
  /** Every distinct network-reaching program this command names. More than one means
   *  no key, so the set stays small and the answer is a name or nothing. */
  const networkPrograms = new Set<string>();
  /** True when a `$(…)`, a backtick, an `iex` string or a here-doc a shell reads
   *  reached a host: the bytes still left, but the program that sent them is inside
   *  a block this card cannot show the owner the whole of, so no program is named. */
  let networkThroughNestedShell = false;
  /** How many statements matched an `rdelete` rule. Two of them means the folder
   *  this function could name covers only one of the two cards' worth of targets. */
  let rdeleteStatements = 0;
  let rdeleteKey: { key: string; targets: readonly string[] } | undefined;
  /** The one file the secret gate can locate, when it is what raised this card. */
  let secretApprovalFile: string | undefined;
  const shellReadsHeredoc = parsed.statements.some((statement) => feedsHeredocToShell(statement));
  const scriptNested = scriptNestedCommands(
    command,
    shell,
    {
      platform: check.platform ?? process.platform,
      ...(check.cwd ? { cwd: check.cwd } : {}),
      ...(check.home ? { home: check.home } : {}),
      ...(check.readScript ? { readScript: check.readScript } : {}),
    },
    { bodies: heredocs.bodies, redirects: parsed.redirects },
    scriptDepth,
    scriptPaths,
  );
  const nestedCommands = [
    ...scriptNested,
    ...heredocs.bodies.filter((body) => shellReadsHeredoc || body.expands).map((body) => body.text),
    ...nestedShellCommands(command, shell),
    ...extractCommandStrings(parsed.statements),
  ];
  for (const nestedCommand of nestedCommands) {
    if (typeof nestedCommand !== 'string' && 'rule' in nestedCommand) {
      if (precedence(nestedCommand.rule.class) > precedence(strongest.classification)) {
        strongest = { classification: nestedCommand.rule.class, rule: nestedCommand.rule };
      }
      continue;
    }
    const nestedText = typeof nestedCommand === 'string' ? nestedCommand : nestedCommand.command;
    // A block that only compares `$_` properties stays read-only; any other
    // nested command (a call, an assignment) ranks like a top-level one.
    if (shell !== 'bash' && isPurePwshExpression(nestedText)) continue;
    const nestedIsScript =
      typeof nestedCommand !== 'string' && 'script' in nestedCommand && nestedCommand.script;
    const nestedPaths = nestedIsScript
      ? new Set([...scriptPaths, nestedCommand.path])
      : scriptPaths;
    const nested = classifyShellCommandAtDepth(
      nestedText,
      typeof nestedCommand === 'string' ? shell : nestedCommand.shell,
      check,
      scriptDepth + (nestedIsScript ? 1 : 0),
      nestedPaths,
    );
    if (precedence(nested.classification) > precedence(strongest.classification)) {
      // The nested block's OWN approval key is dropped rather than inherited. The
      // outer command cannot show the owner the targets a nested shell worked out, so
      // a key from inside `$(…)`, a backtick or an `iex` string would name a folder
      // the card never displayed — which is the one thing a key may not do.
      strongest = {
        classification: nested.classification,
        ...(nested.rule ? { rule: nested.rule } : {}),
        ...(nested.readSecretIgnoringAllowList
          ? { readSecretIgnoringAllowList: nested.readSecretIgnoringAllowList }
          : {}),
      };
    }
    // A nested command's network reach travels up: `$(curl -d @notes.txt https://x)`
    // sends bytes out even though the outer program is `echo`. It travels up WITHOUT
    // a program name, because the program is inside a block the owner cannot see the
    // whole of on this card, and a key for half a card is a card half-answered.
    if (nested.networkReaching) {
      networkSeen = true;
      networkThroughNestedShell = true;
    }
    if (nested.elevatedProcess) elevationSeen = true;
  }
  // A `cd` writes nothing, so it may count as a read — but only when nothing in
  // the same command writes INTO Forge's own files. A redirection is the trap:
  // `cd ~/.forge && echo hi > notes.txt` is made of two read-only programs and
  // still creates a file, and its target is relative, so it lands in the folder
  // the `cd` just moved to. It is now judged there, by `firstOwnerOnlyRedirect`,
  // rather than refusing every command that contains a `>`: `cd ~/.forge/sessions
  // && ls > /tmp/out.txt` writes outside Forge's files and used to be refused as
  // if it wrote inside them.
  const ownerSet = ownerOnlySetForGuard(check);
  const redirectHit =
    ownerSet && parsed.redirection
      ? firstOwnerOnlyRedirect(sourceStatements, parsed.redirects, ownerSet, check.cwd)
      : undefined;
  const cdReadonly = commandIsAllReadOnly(statements, shell) && redirectHit === undefined;
  for (const statement of statements) {
    const networkProgram = statementNetworkProgram(statement);
    if (networkProgram !== undefined) {
      networkSeen = true;
      networkPrograms.add(networkProgram);
    }
    const rule = rules.find((candidate) => candidate.match(statement));
    if (rule?.keyKind === 'rdelete') {
      rdeleteStatements += 1;
      if (rdeleteStatements === 1) {
        const targets = rdeleteTargetsFor(statement, check);
        if (targets) {
          const folder = commonFolderOf(targets, folderContext);
          if (folder) rdeleteKey = { key: `rdelete:${folder}`, targets };
        }
      }
    }
    const current: ShellClassification = rule
      ? { classification: rule.class, rule }
      : {
          classification:
            parsed.disqualifiesReadOnly ||
            parsed.redirection ||
            !isReadOnly(statement, shell, cdReadonly)
              ? 'normal'
              : 'read_only',
        };
    if (precedence(current.classification) > precedence(strongest.classification))
      strongest = current;
  }
  // The two questions asked of one matcher, and the answers are not the same:
  // `honorAllowList` false is the TAINT question (an owner-allowed `.env` still costs
  // this chat its next fetch), true is the CARD question (that same path asks for
  // nothing). Both are read before the rewrites below, because a path inside `$(…)`
  // or a here-document only surfaces in a nested classification.
  const readsMetadataTargets = new Set<number>();
  for (let index = 0; index < parsed.separators.length; index += 1) {
    if (parsed.separators[index] !== 'pipe') continue;
    // A listing's objects reach every later stage of the SAME pipeline, so the reader
    // may sit behind `Select-Object -First 1`: walk forward while the separators stay
    // pipes, and stop at a `&&` or `;`, which starts a different command.
    for (let stage = index + 1; stage < statements.length; stage += 1) {
      if (pipeTargetReadsContents(statements[stage] ?? [], shell)) {
        readsMetadataTargets.add(index);
        break;
      }
      if (parsed.separators[stage] !== 'pipe') break;
    }
  }
  const cardSecretRead = secretReadInStatements(
    statements,
    secretScan(check, true, readsMetadataTargets, shell),
  );
  const readSecret =
    secretReadInStatements(statements, secretScan(check, false, readsMetadataTargets, shell))
      ?.pattern ?? strongest.readSecretIgnoringAllowList;
  if (parsed.redirection && strongest.classification === 'read_only')
    strongest = { classification: 'normal' };
  // The owner guard, ahead of the secret gate: a command that both reads a
  // secret and writes Forge's own config is refused outright, and a `refused`
  // already won from a nested shell keeps its own, more specific rule.
  const ownerRule = ownerSet
    ? ownerOnlyShellRule({
        statements,
        shell,
        ...(check.cwd ? { cwd: check.cwd } : {}),
        cdReadonly,
        set: ownerSet,
        ...(redirectHit ? { redirectHit } : {}),
      })
    : undefined;
  if (ownerRule && precedence('refused') > precedence(strongest.classification))
    strongest = { classification: 'refused', rule: ownerRule };
  const secretRule = secretRuleFor(cardSecretRead?.pattern);
  if (secretRule && precedence('dangerous') > precedence(strongest.classification)) {
    strongest = { classification: 'dangerous', rule: secretRule };
    // The key is the file, not the pattern: `*.pem` says which rule matched, and a
    // chat rule has to name the one file the owner is agreeing to let this chat read.
    // When the command reads two secret files, or reads one whose path it builds at
    // run time, there is no file to name and the card stays unkeyable.
    secretApprovalFile = cardSecretRead?.file;
  }
  // A read-only command whose PATH argument is built at run time cannot be
  // judged by tokens at all, so it asks: `Get-Content ("~/.s" + "sh/id_rsa")`
  // names no secret to this classifier, and neither does `cat $(printf …)`.
  if (
    strongest.classification === 'read_only' &&
    statements.some((statement) => argumentLooksComputed(statement))
  )
    strongest = { classification: 'normal' };
  /** The key this call's own gate knows, if it knows one: the folder a readable
   *  recursive delete is inside, or the one file the secret gate located. The deny
   *  list's other dangerous rules, and any gate that names neither, get nothing and
   *  ask the owner every time. */
  const gateKey: { key: string; targets?: readonly string[] } | undefined =
    strongest.rule?.keyKind === 'rdelete' && rdeleteStatements === 1 && rdeleteKey
      ? rdeleteKey
      : secretApprovalFile !== undefined
        ? { key: `secret:${secretApprovalFile}` }
        : undefined;
  /** One program, reached directly, is a key. Two programs, or a host reached from
   *  inside a nested shell, is not: see `networkProgram` above. */
  const singleNetworkProgram =
    networkSeen && !networkThroughNestedShell && networkPrograms.size === 1
      ? [...networkPrograms][0]
      : undefined;
  return {
    ...strongest,
    ...(elevationSeen ? { elevatedProcess: true } : {}),
    ...(readSecret ? { readSecretIgnoringAllowList: readSecret } : {}),
    ...(networkSeen && !strongest.networkReaching ? { networkReaching: true } : {}),
    ...(singleNetworkProgram ? { networkProgram: singleNetworkProgram } : {}),
    ...(gateKey
      ? {
          approvalKey: gateKey.key,
          ...(gateKey.targets ? { approvalTargets: gateKey.targets } : {}),
        }
      : {}),
  };
}

/**
 * The secret scan's options for one command: its config, the home `~` expands
 * against, the platform being judged, the folder the command's relative paths
 * resolve against, and which of the two questions is being asked. Built here rather
 * than inside the scanner so `shellPolicy.ts` stays the place that knows what a
 * command's environment is, and the scanner stays the place that knows what a
 * secret path is.
 */
function secretScan(
  check: ShellSecretCheck,
  honorAllowList: boolean,
  readsMetadataTargets?: ReadonlySet<number>,
  shell?: ShellKind,
): {
  config?: ForgeConfig;
  home?: string;
  platform?: NodeJS.Platform;
  cwd?: string;
  honorAllowList: boolean;
  shell?: ShellKind;
  readsMetadataTargets?: ReadonlySet<number>;
} {
  return {
    ...(check.getConfig ? { config: check.getConfig() } : {}),
    ...(check.home ? { home: check.home } : {}),
    ...(check.platform ? { platform: check.platform } : {}),
    ...(check.cwd ? { cwd: check.cwd } : {}),
    honorAllowList,
    ...(shell ? { shell } : {}),
    ...(readsMetadataTargets ? { readsMetadataTargets } : {}),
  };
}

/**
 * The rule for a secret path the owner has not allowed. The command is dangerous
 * so unattended policy denies it instead of allowing a job to read the file.
 */
function secretRuleFor(pattern: string | undefined): ShellTokenRule | undefined {
  if (!pattern) return undefined;
  return {
    match: () => true,
    description: `reads a secret path (${pattern})`,
    alternative: secretDeclineHint(pattern),
    class: 'dangerous',
    gateKind: 'ownerGate',
  };
}
