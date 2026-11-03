import { describe, expect, it } from 'vitest';
import {
  approvalsSlashCommand,
  linkSlashCommand,
  SLASH_COMMANDS,
  unknownSlashCommand,
} from '../../webview-ui/src/slashCommands';

/**
 * The composer's own parsing rules, pinned where they live.
 *
 * Two of the 0.17.117 live-test defects are commands the owner typed in the
 * wrong case and the product answered with a model turn: `/APPROVALS RESET`
 * went to the model instead of clearing the chat's rules, and an unknown name
 * got a whole turn of tokens instead of being told the name is wrong. Both are
 * decided in `slashCommands.ts`, so both are checked here rather than in the
 * chat, where a turn's answer is a much less precise thing to assert about.
 */
describe('slash commands ignore the case they are typed in', () => {
  it('accepts /approvals and its subcommand in any case', () => {
    expect(approvalsSlashCommand('/approvals')).toEqual({ commandId: 'approvals' });
    expect(approvalsSlashCommand('/APPROVALS')).toEqual({ commandId: 'approvals' });
    expect(approvalsSlashCommand('  /Approvals Reset  ')).toEqual({
      commandId: 'approvals',
      approvalAction: 'reset',
    });
    // The subcommand is still the only one there is, and a wrong one is still
    // reported as wrong rather than silently treated as a list.
    expect(approvalsSlashCommand('/APPROVALS Wipe')).toEqual({
      commandId: 'approvals',
      approvalAction: 'invalid',
    });
    expect(approvalsSlashCommand('/approvals2')).toBeUndefined();
  });

  it('accepts /link in any case and keeps the case of what it is given', () => {
    expect(linkSlashCommand('/LINK Claude ses-1')).toEqual({
      commandId: 'linkAgent',
      agentKind: 'Claude',
      sessionId: 'ses-1',
    });
    // An agent kind and a session id are data the host matches exactly; only the
    // command word is case-free.
    expect(linkSlashCommand('/Link')).toEqual({ commandId: 'linkAgent' });
  });
});

describe('an unknown slash command is caught before it becomes a turn', () => {
  it('names the word the owner typed', () => {
    expect(unknownSlashCommand('/foo')).toEqual({ command: '/foo' });
    expect(unknownSlashCommand('/ChatModeX')).toEqual({ command: '/ChatModeX' });
    expect(unknownSlashCommand('   /undo-it   ')).toEqual({ command: '/undo-it' });
  });

  it('leaves a real command alone, whatever its case or arguments', () => {
    for (const text of ['/approvals', '/APPROVALS RESET', '/chatmode', '/ChatMode', '/link']) {
      expect(unknownSlashCommand(text), text).toBeUndefined();
    }
    // A multi-word trigger is matched by its first word, which is the word the
    // popup accepts and the host dispatches on.
    expect(unknownSlashCommand('/approvals reset')).toBeUndefined();
  });

  it('sends prose that merely starts with a slash', () => {
    // The owner's own example: a path has a second slash in its first token, so
    // it is not a command word and nothing here may swallow it.
    expect(unknownSlashCommand('/usr/bin is broken')).toBeUndefined();
    expect(unknownSlashCommand('/foo/bar baz')).toBeUndefined();
    // Not a command shape at all: digits, punctuation, an empty box.
    expect(unknownSlashCommand('/5')).toBeUndefined();
    expect(unknownSlashCommand('/')).toBeUndefined();
    expect(unknownSlashCommand('')).toBeUndefined();
    expect(unknownSlashCommand('check /foo later')).toBeUndefined();
  });

  it('every trigger the popup lists is known to this check', () => {
    // The check and the popup must agree, or a command a user can click would be
    // refused when typed — the exact shape of the `/restartBackend` doc bug
    // `CommandNamesExist.test.ts` exists to catch.
    for (const cmd of SLASH_COMMANDS) {
      expect(unknownSlashCommand(`/${cmd.trigger}`), cmd.trigger).toBeUndefined();
    }
  });
});

describe('the popup offers /approvals reset', () => {
  it('lists it as its own row that carries the reset action', () => {
    const index = SLASH_COMMANDS.findIndex((cmd) => cmd.id === 'approvals');
    expect(SLASH_COMMANDS[index]).toMatchObject({ trigger: 'approvals' });
    // The plain row must not carry the action, or `/approvals` itself would
    // clear the rules it was asked to list.
    expect(SLASH_COMMANDS[index]!.approvalAction).toBeUndefined();
    // Directly after /approvals, so the two sit together in a menu sorted by
    // what the user types, and the reset row is the one the query `/approvals r`
    // matches.
    expect(SLASH_COMMANDS[index + 1]).toMatchObject({
      id: 'approvals',
      trigger: 'approvals reset',
      title: 'Reset Chat Approvals',
      approvalAction: 'reset',
      availableWhileStreaming: true,
    });
  });
});
