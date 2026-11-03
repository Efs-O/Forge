/**
 * The plain-words table from `docs/plans/ASK_ONCE_APPROVALS_PLAN.md` §2, row by
 * row: the card line, the `/approvals` listing and the Telegram receipt all read
 * through this one table, so what the owner was told they allowed is what the
 * rule actually says. The last two cases matter as much as the table: a key this
 * file does not know prints ITSELF, so a key added by a later phase — or typed
 * into `policy.yaml` by hand — cannot be shown as a sentence nobody agreed to.
 */
import { describe, expect, it } from 'vitest';
import {
  describeApprovalKey,
  describeApprovalKeys,
} from '../../src/sidebar/approvalKeyWords';

describe('describeApprovalKey', () => {
  it.each([
    ['net:huggingface.co', 'any request to huggingface.co'],
    ['net:prog:curl', 'network commands run with curl'],
    ['net:prog:git-push', 'network commands run with git-push'],
    ['cross_chat', 'messages to other chats'],
    ['delegate:codex', 'asking codex'],
    ['write:N:/Strata', 'writes inside N:/Strata'],
    [
      'secret:C:/Users/x/.forge/agent-bus/endpoint.json',
      'reading C:/Users/x/.forge/agent-bus/endpoint.json',
    ],
    ['tool:git_commit', 'the git_commit tool'],
    ['rdelete:D:/Downloads', 'recursive deletes inside D:/Downloads'],
  ])('says what %s covers', (key, words) => {
    expect(describeApprovalKey(key)).toBe(words);
  });

  it('prints an unknown key itself rather than inventing words for it', () => {
    // A key this table has never heard of — one phase 4 adds, or one typed into
    // `policy.yaml` by hand — still has to be shown truthfully.
    expect(describeApprovalKey('policy:jobs/strata-update')).toBe('policy:jobs/strata-update');
    expect(describeApprovalKey('NET:curl')).toBe('NET:curl');
  });

  it('prints a key that names nothing itself, so no line has a blank in it', () => {
    for (const key of ['net:', 'net:prog:', 'write:', 'rdelete:', 'tool:', 'delegate:']) {
      expect(describeApprovalKey(key)).toBe(key);
    }
  });
});

describe('describeApprovalKeys', () => {
  it.each([
    [['cross_chat'], 'messages to other chats'],
    [['net:prog:curl', 'cross_chat'], 'network commands run with curl and messages to other chats'],
    [
      ['rdelete:D:/Downloads', 'net:prog:curl', 'cross_chat'],
      'recursive deletes inside D:/Downloads, network commands run with curl and messages to other chats',
    ],
    [[], ''],
  ])('joins %s the way a person reads it', (keys, words) => {
    expect(describeApprovalKeys(keys)).toBe(words);
  });

  it('names every key it was given, so a card cannot hide one behind a comma', () => {
    const keys = ['write:N:/Strata', 'secret:C:/Users/x/.ssh/id_ed25519'];
    const line = describeApprovalKeys(keys);
    for (const key of keys) expect(line).toContain(describeApprovalKey(key));
  });
});
