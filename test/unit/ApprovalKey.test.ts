/**
 * The key table from `docs/plans/ASK_ONCE_APPROVALS_PLAN.md` §2, row by row, plus
 * the fail-closed cases the plan calls out by name: a path the matcher cannot read,
 * a wildcard, two network programs in one command, a nested shell, and a
 * `Remove-Item` switch this matcher does not know. Every one of those must come back
 * `unkeyable`, because a key built from a guess is an approval the owner never made.
 *
 * The environment is injected (`C:/Users/someone`, `N:/ws/project`, one
 * `extra_file_roots` entry, `~/.forge/` owner-only) so nothing here depends on who
 * is logged in on the machine running the test.
 */
import { describe, expect, it } from 'vitest';
import { classifyShellCommand } from '../../src/tools/shellPolicy';
import {
  approvalKeysFor,
  ruleCovers,
  validateRuleKey,
  type ApprovalKeyInput,
  type ApprovalRequirement,
} from '../../src/sidebar/approvalKey';
import type { ApprovalKeyContext } from '../../src/sidebar/approvalKeyGrammar';

const HOME = 'C:/Users/someone';
const WORKSPACE = 'N:/ws/project';
const CTX: ApprovalKeyContext = {
  platform: 'win32',
  home: HOME,
  workspaceRoot: WORKSPACE,
  ownerOnly: [`${HOME}/.forge`],
  extraFileRoots: ['N:/Strata'],
};

/** The same call, told three ways: a flagged exit, a tool gate, and a write outside. */
function input(over: Partial<ApprovalKeyInput> = {}): ApprovalKeyInput {
  return {
    toolName: 'shell',
    dangerous: false,
    toolGate: false,
    outsideWorkspace: false,
    declaredSafe: false,
    reachesOut: 'none',
    ...over,
  };
}

/** The keys a call needs, as the flat list a table can compare against. */
function keysOf(call: ApprovalKeyInput, ctx = CTX): string | string[] {
  const keys = approvalKeysFor(call, ctx);
  return keys.kind === 'unkeyable' ? 'unkeyable' : keys.requirements.map((req) => req.key);
}

/**
 * A shell call as `ToolDispatch` would present it: the classifier's own facts, plus
 * the card the untrusted flag raised (`taintGate`) for a call whose gate is only the
 * card's text. A dangerous call's `denyList` kind comes from the rule itself, and
 * `approvalKeysFor` answers the deny list before the exit, so this default cannot
 * make a refused command look keyable.
 */
function flaggedShell(command: string, over: Partial<ApprovalKeyInput> = {}): ApprovalKeyInput {
  const classified = classifyShellCommand(command, 'bash', {
    home: HOME,
    platform: 'win32',
    cwd: WORKSPACE,
    ownerOnly: CTX.ownerOnly,
  });
  return {
    ...input(),
    dangerous: classified.classification === 'dangerous',
    // A dangerous shell call's card comes from the rule, so the flag did not raise
    // it; a `normal` or `read_only` one's card comes from the flag, because the
    // classifier's metadata for those is only the card's text (`cardTextOnly`).
    toolGate: classified.classification === 'dangerous',
    reachesOut: classified.networkReaching ? 'network' : 'none',
    ...(classified.classification === 'dangerous' ? {} : { exitGateKind: 'taintGate' as const }),
    ...(classified.networkProgram ? { approvalKey: `net:prog:${classified.networkProgram}` } : {}),
    ...(classified.approvalKey ? { approvalKey: classified.approvalKey } : {}),
    ...(classified.approvalTargets ? { approvalTargets: classified.approvalTargets } : {}),
    ...(classified.rule?.gateKind ? { approvalGateKind: classified.rule.gateKind } : {}),
    ...over,
  };
}

/** A requirement, in the shape `approvalKeysFor` returns: a key, plus the targets a
 *  folder key claims to cover. */
function req(key: string, targets?: string[]): ApprovalRequirement {
  return { key, ...(targets ? { targets } : {}) };
}

describe('approvalKeysFor, the plan §2 table', () => {
  it.each([
    ['a network exit through one program', 'curl -s https://x', ['net:prog:curl']],
    ['a git push', 'git push origin main', ['net:prog:git-push']],
    ['a package install', 'npm install zod', ['net:prog:npm-install']],
    ['a remote copy', 'scp notes.txt host:/tmp/', ['net:prog:scp']],
  ])('%s keys as %j', (_label, command, expected) => {
    expect(keysOf(flaggedShell(command))).toEqual(expected);
  });

  it('keys a fetch to the host the card named, not the payload or the path', () => {
    expect(
      keysOf(
        input({
          toolName: 'web_fetch',
          toolGate: true,
          approvalKey: 'net:huggingface.co',
        }),
      ),
    ).toEqual(['net:huggingface.co']);
  });

  it('keys a cross-chat send with one key, whatever the tool', () => {
    // `message_chat` has no gate of its own, so in a flagged chat the flag is what
    // cards it, and `cross_chat` is the whole of what the call does.
    expect(
      keysOf(
        input({
          toolName: 'message_chat',
          reachesOut: 'cross_chat',
          exitGateKind: 'taintGate',
        }),
      ),
    ).toEqual(['cross_chat']);
  });

  it('keys a delegation by its target agent, lower-cased', () => {
    expect(
      keysOf(
        input({
          toolName: 'ask_local_agent',
          reachesOut: 'delegation',
          exitGateKind: 'taintGate',
          delegateTarget: 'codex',
        }),
      ),
    ).toEqual(['delegate:codex']);
  });

  it('keys a delegation the tool itself gated by the tool, not by the target', () => {
    // `ask_local_agent` gates a local target because of the VRAM it loads, and that
    // card is about the tool, so a rule for `delegate:codex` does not answer it.
    expect(
      keysOf(
        input({
          toolName: 'ask_local_agent',
          toolGate: true,
          reachesOut: 'delegation',
          delegateTarget: 'codex',
        }),
      ),
    ).toEqual(['tool:ask_local_agent']);
  });

  it('keys a write outside the workspace by the folder the owner sanctioned', () => {
    const keys = approvalKeysFor(
      input({
        toolName: 'write_file',
        outsideWorkspace: true,
        outsideMutationPaths: ['N:/Strata/sub/notes.txt'],
        mutationPaths: ['N:/Strata/sub/notes.txt'],
      }),
      CTX,
    );
    expect(keys.kind === 'keyed' ? keys.requirements : keys).toEqual([
      { key: 'write:N:/Strata', targets: ['N:/Strata/sub/notes.txt'] },
    ]);
  });

  it('falls back to the parent folder of the paths when no root covers them', () => {
    expect(
      keysOf(
        input({
          outsideWorkspace: true,
          outsideMutationPaths: ['N:/Other/deep/notes.txt'],
          mutationPaths: ['N:/Other/deep/notes.txt'],
        }),
      ),
    ).toEqual(['write:N:/Other/deep']);
  });

  it('keys a secret read by the exact file, even though the gate is dangerous', () => {
    expect(
      keysOf(
        input({
          toolName: 'read_file',
          dangerous: true,
          toolGate: true,
          approvalGateKind: 'ownerGate',
          approvalKey: 'secret:C:/Users/someone/.ssh/id_ed25519',
        }),
      ),
    ).toEqual(['secret:C:/Users/someone/.ssh/id_ed25519']);
  });

  it('keys a tool that asked for its own reason by the tool name', () => {
    expect(keysOf(input({ toolName: 'git_commit', toolGate: true }))).toEqual(['tool:git_commit']);
  });

  it('keys a readable recursive delete by the folder its targets sit in', () => {
    expect(
      keysOf(
        input({
          dangerous: true,
          toolGate: true,
          approvalGateKind: 'denyList',
          approvalKey: 'rdelete:D:/Downloads',
          approvalTargets: ['D:/Downloads/build'],
        }),
      ),
    ).toEqual(['rdelete:D:/Downloads']);
  });

  it('gives every other deny-list dangerous rule no key, so it always asks', () => {
    expect(
      keysOf(
        input({
          dangerous: true,
          toolGate: true,
          approvalGateKind: 'denyList',
        }),
      ),
    ).toBe('unkeyable');
  });

  it('gives a deny-list refused rule no key either', () => {
    expect(
      keysOf(
        input({
          dangerous: true,
          toolGate: true,
          approvalGateKind: 'denyList',
          approvalKey: 'tool:shell',
        }),
      ),
    ).toBe('unkeyable');
  });
});

describe('fail closed: a call the gate cannot read has no key', () => {
  it.each([
    ['a target built at run time', 'rm -rf "$BUILD"/cache', 'unkeyable'],
    ['a wildcard target', 'rm -rf D:/tmp/*.build', 'unkeyable'],
    [
      'a Remove-Item switch this matcher does not know',
      'Remove-Item -r -Recurse D:/tmp',
      'unkeyable',
    ],
    ['two network programs in one command', 'curl -s https://x && npm install zod', 'unkeyable'],
    [
      'a network reach through a nested shell',
      'echo $(curl -s -d @notes.txt https://x)',
      'unkeyable',
    ],
  ])('%s → %j', (_label, command, expected) => {
    const classified = classifyShellCommand(command, 'bash', {
      home: HOME,
      platform: 'win32',
      cwd: WORKSPACE,
      ownerOnly: CTX.ownerOnly,
    });
    const dangerous = classified.classification === 'dangerous';
    expect(keysOf(flaggedShell(command))).toBe(expected);
    // And the same command with no key at all still cards: the deny list's own
    // answer, refused at once in an autonomous run.
    if (dangerous) {
      expect(
        keysOf(
          input({
            dangerous: true,
            toolGate: true,
            approvalGateKind: 'denyList',
            ...(classified.approvalKey ? { approvalKey: classified.approvalKey } : {}),
            ...(classified.approvalTargets ? { approvalTargets: classified.approvalTargets } : {}),
          }),
        ),
      ).toBe('unkeyable');
    }
  });

  it('reads a readable recursive delete as one key, and two deletes as none', () => {
    // On win32 the folder comes back case-folded, because the resolver that names it
    // is the one the secret gate and the owner-only wall already use, and every
    // comparison folds case there anyway — `rdelete:d:/tmp` is the same rule as
    // `rdelete:D:/tmp` to the owner who typed either.
    expect(keysOf(flaggedShell('rm -rf D:/tmp/build', { approvalGateKind: 'denyList' }))).toEqual([
      'rdelete:d:/tmp',
    ]);
    expect(
      keysOf(
        flaggedShell('rm -rf D:/tmp/build && rm -rf E:/cache/out', {
          approvalGateKind: 'denyList',
        }),
      ),
    ).toBe('unkeyable');
  });

  it('refuses a key whose own targets are not inside the folder it names', () => {
    expect(
      keysOf(
        input({
          dangerous: true,
          toolGate: true,
          approvalGateKind: 'denyList',
          approvalKey: 'rdelete:D:/Downloads',
          approvalTargets: ['D:/Other/build'],
        }),
      ),
    ).toBe('unkeyable');
  });

  it('refuses a key whose target is the folder the key itself names', () => {
    expect(
      keysOf(
        input({
          dangerous: true,
          toolGate: true,
          approvalGateKind: 'denyList',
          approvalKey: 'rdelete:D:/Downloads',
          approvalTargets: ['D:/Downloads'],
        }),
      ),
    ).toBe('unkeyable');
  });

  it('gives a delete of the profile root no key, even told under a rule for the folder above it', () => {
    const keys = approvalKeysFor(
      input({
        dangerous: true,
        toolGate: true,
        approvalGateKind: 'denyList',
        approvalKey: 'rdelete:C:/Users',
        approvalTargets: [HOME],
      }),
      CTX,
    );
    expect(keys.kind).toBe('unkeyable');
    if (keys.kind === 'unkeyable') expect(keys.why).toContain(HOME);
  });

  it('refuses a dangerous gate that named nothing, rather than keying it tool:', () => {
    expect(
      keysOf(
        input({
          toolName: 'delete_file',
          dangerous: true,
          toolGate: true,
        }),
      ),
    ).toBe('unkeyable');
  });

  it('refuses a delegation that names no target agent', () => {
    expect(
      keysOf(
        input({
          toolName: 'ask_local_agent',
          reachesOut: 'delegation',
          exitGateKind: 'taintGate',
          toolGate: true,
        }),
      ),
    ).toBe('unkeyable');
  });

  it('refuses a network exit whose gate named no program', () => {
    expect(
      keysOf(
        input({
          reachesOut: 'network',
          exitGateKind: 'taintGate',
          toolGate: true,
        }),
      ),
    ).toBe('unkeyable');
  });

  it('keys a clean read-only `curl -I` by its program, so a flagged chat asks once', () => {
    const classified = classifyShellCommand('curl -I https://x', 'bash', {
      home: HOME,
      platform: 'win32',
      cwd: WORKSPACE,
    });
    expect(classified.networkProgram).toBe('curl');
    expect(
      keysOf(
        input({
          reachesOut: 'network',
          exitGateKind: 'taintGate',
          toolGate: false,
          declaredSafe: true,
          approvalKey: 'net:prog:curl',
        }),
      ),
    ).toEqual(['net:prog:curl']);
  });
});

describe('ruleCovers', () => {
  it('does not let a shorter folder name cover a longer one beside it', () => {
    expect(ruleCovers('rdelete:D:/Down', req('rdelete:D:/Down', ['D:/Downloads/build']), CTX)).toBe(
      false,
    );
    expect(
      ruleCovers('rdelete:D:/Downloads', req('rdelete:D:/Downloads', ['D:/Downloads/build']), CTX),
    ).toBe(true);
  });

  it('does not cover a delete of the very folder the rule names, only one inside it', () => {
    expect(
      ruleCovers('rdelete:D:/Downloads', req('rdelete:D:/Downloads', ['D:/Downloads']), CTX),
    ).toBe(false);
    expect(
      ruleCovers('rdelete:D:/Downloads', req('rdelete:D:/Downloads', ['D:/Downloads/a/b/c']), CTX),
    ).toBe(true);
    // `write:` keeps the equal case on purpose: writing to the root the owner put
    // in `extra_file_roots` is exactly what listing that root meant.
    expect(ruleCovers('write:N:/Strata', req('write:N:/Strata', ['N:/Strata']), CTX)).toBe(true);
  });

  it('compares case the way the file system does on win32', () => {
    expect(
      ruleCovers('rdelete:d:/downloads', req('rdelete:D:/Downloads', ['D:/DOWNLOADS/build']), CTX),
    ).toBe(true);
  });

  it('keeps a target that escapes the folder with `..` outside it', () => {
    expect(
      ruleCovers(
        'rdelete:D:/Downloads',
        req('rdelete:D:/Downloads', ['D:/Downloads/../Other']),
        CTX,
      ),
    ).toBe(false);
  });

  it('requires every target to be inside, not just the first', () => {
    expect(
      ruleCovers(
        'rdelete:D:/Downloads',
        req('rdelete:D:/Downloads', ['D:/Downloads/a', 'D:/Other/b']),
        CTX,
      ),
    ).toBe(false);
  });

  it('covers a write inside the sanctioned root and not one beside it', () => {
    expect(
      ruleCovers('write:N:/Strata', req('write:N:/Strata', ['N:/Strata2/file.txt']), CTX),
    ).toBe(false);
    expect(
      ruleCovers('write:N:/Strata', req('write:N:/Strata', ['N:/Strata/sub/file.txt']), CTX),
    ).toBe(true);
  });

  it('matches every other key exactly, case-insensitively where the name is', () => {
    expect(ruleCovers('net:prog:curl', req('net:prog:curl'), CTX)).toBe(true);
    expect(ruleCovers('net:prog:curl', req('net:prog:wget'), CTX)).toBe(false);
    expect(ruleCovers('net:HuggingFace.co', req('net:huggingface.co'), CTX)).toBe(true);
    expect(ruleCovers('cross_chat', req('cross_chat'), CTX)).toBe(true);
    expect(ruleCovers('cross_chat', req('delegate:codex'), CTX)).toBe(false);
    expect(ruleCovers('delegate:codex', req('delegate:claude'), CTX)).toBe(false);
    expect(ruleCovers('tool:git_commit', req('tool:git_commit'), CTX)).toBe(true);
  });

  it('will not let a folder rule answer a requirement that names no targets', () => {
    expect(ruleCovers('rdelete:D:/Downloads', req('rdelete:D:/Downloads'), CTX)).toBe(false);
  });

  it('will not let a rule that is not a legal key cover anything', () => {
    expect(
      ruleCovers('rdelete:C:/Windows', req('rdelete:D:/Downloads', ['D:/Downloads']), CTX),
    ).toBe(false);
    expect(ruleCovers('nonsense:D:/x', req('nonsense:D:/x'), CTX)).toBe(false);
  });
});

describe('validateRuleKey', () => {
  it.each([
    ['cross_chat', undefined],
    ['net:huggingface.co', undefined],
    ['net:prog:git-push', undefined],
    ['delegate:codex', undefined],
    ['tool:git_commit', undefined],
    ['write:N:/Strata', undefined],
    ['secret:C:/Users/someone/.ssh/id_ed25519', undefined],
    ['rdelete:D:/Downloads', undefined],
    ['rdelete:N:/ws/project/docs', undefined],
    ['write:N:/ws/project', undefined],
  ])('accepts %s', (key, expected) => {
    expect(validateRuleKey(key, CTX)).toBe(expected);
  });

  it.each([
    ['an empty rule', ''],
    ['a word with no key prefix', 'allow curl'],
    ['an unknown prefix', 'nonsense:D:/x'],
    ['net: with no host', 'net:'],
    ['net: with a path', 'net:huggingface.co/api'],
    ['net:prog: with no program', 'net:prog:'],
    ['delegate: with no agent', 'delegate:'],
    ['tool: with no tool', 'tool:'],
    ['tool: naming something that is not a tool name', 'tool:git commit'],
    ['write: with a relative path', 'write:docs/notes'],
    ['secret: with a relative path', 'secret:.env'],
    ['rdelete: with a relative path', 'rdelete:build'],
    ['rdelete: a disk root', 'rdelete:C:/'],
    ['rdelete: the user-profile root', `rdelete:${HOME}`],
    ['rdelete: an ancestor of the user-profile root', 'rdelete:C:/Users'],
    ['rdelete: the workspace root itself', `rdelete:${WORKSPACE}`],
    ['rdelete: an ancestor of the workspace root', 'rdelete:N:/ws'],
    ['rdelete: an ancestor of an owner-only root', 'rdelete:N:/owner'],
    ['rdelete: inside Windows', 'rdelete:C:/Windows'],
    ['rdelete: inside a subfolder of Windows', 'rdelete:C:/Windows/system32'],
    ['rdelete: inside Program Files', 'rdelete:C:/Program Files'],
    ['rdelete: inside Program Files (x86)', 'rdelete:C:/Program Files (x86)'],
    ['rdelete: inside ~/.forge', `rdelete:${HOME}/.forge/jobs`],
    ['write: inside ~/.forge', `write:${HOME}/.forge/config.yaml`],
    ['secret: inside ~/.forge', `secret:${HOME}/.forge/agent-bus/endpoint.json`],
    ['rdelete: inside an owner-only root', 'rdelete:N:/owner/deep'],
    ['write: inside an owner-only root', 'write:N:/owner/deep/file.txt'],
  ])('refuses %s', (_label, key) => {
    const reason = validateRuleKey(key, { ...CTX, ownerOnly: [`${HOME}/.forge`, 'N:/owner'] });
    expect(reason ?? '').not.toBe('');
    expect(reason).toMatch(/refused|needs|inside|is not|names|must|root|unknown/iu);
  });

  it('refuses a disk root on a POSIX platform too', () => {
    const nix: ApprovalKeyContext = {
      platform: 'linux',
      home: '/home/someone',
      workspaceRoot: '/home/someone/project',
      ownerOnly: ['/home/someone/.forge'],
      extraFileRoots: [],
    };
    expect(validateRuleKey('rdelete:/', nix)).toContain('disk root');
    expect(validateRuleKey('rdelete:/home/someone/.forge', nix)).toContain('only the owner');
    expect(validateRuleKey('rdelete:/tmp/build', nix)).toBeUndefined();
    expect(validateRuleKey('write:/home/someone/project/docs', nix)).toBeUndefined();
  });

  it('does not refuse a folder whose name only starts like Program Files', () => {
    expect(validateRuleKey('rdelete:C:/Program Files More/build', CTX)).toBeUndefined();
  });

  it('refuses a folder that CONTAINS a protected folder, not only one inside it', () => {
    // The shape this machine actually has: the profile is `C:/Users/efso office`,
    // the workspace sits one level below `N:/vs code apps`, and `.forge` is inside
    // the profile. Naming the folder ABOVE either one deletes the guards along with
    // the work, so neither may be a rule — while a folder strictly inside either
    // stays a rule a chat may hold.
    const real: ApprovalKeyContext = {
      platform: 'win32',
      home: 'C:/Users/efso office',
      workspaceRoot: 'N:/vs code apps/Forge',
      ownerOnly: ['C:/Users/efso office/.forge'],
      extraFileRoots: [],
    };
    expect(validateRuleKey('rdelete:C:/Users', real)).toContain('C:/Users/efso office');
    expect(validateRuleKey('rdelete:N:/vs code apps', real)).toContain('N:/vs code apps/Forge');
    expect(validateRuleKey('rdelete:C:/Users/efso office/.cargo', real)).toBeUndefined();
    expect(validateRuleKey('rdelete:C:/Users/efso office/Documents/build', real)).toBeUndefined();
    expect(validateRuleKey('rdelete:N:/vs code apps/Forge/build', real)).toBeUndefined();
    expect(
      ruleCovers(
        'rdelete:N:/vs code apps/Forge/build',
        req('rdelete:N:/vs code apps/Forge/build', ['N:/vs code apps/Forge/build/out']),
        real,
      ),
    ).toBe(true);
    expect(
      ruleCovers(
        'rdelete:N:/vs code apps/Forge/build',
        req('rdelete:N:/vs code apps/Forge/build', ['N:/vs code apps/Forge']),
        real,
      ),
    ).toBe(false);
  });
});
