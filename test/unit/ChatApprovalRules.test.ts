/**
 * The chat's approval rules: what `allowForChat` will take, what it refuses, where a
 * `net:` key actually goes, and what happens to the rules across a save, a reload and
 * a `/clear`.
 *
 * The plan §7 ledger says these rules live and die with the conversation, so the
 * persistence round trip and the `/clear` row are as much a part of this test as the
 * allow/refuse table: a rule a save lost would put the card back without anyone
 * noticing, and a rule that survived a `/clear` would answer a card for a chat that
 * had already forgotten why it was allowed.
 */
import { describe, expect, it } from 'vitest';
import {
  allowForChat,
  approvalLinesForChat,
  approvalEnvFor,
  chatRules,
  clearChatRules,
  resetChatApprovals,
  coveredByChatRules,
} from '../../src/sidebar/chatApprovalRules';
import {
  clearConversationHostApprovals,
  isHostApproved,
  markHostApproved,
} from '../../src/tools/fetchHostApprovals';
import { clearChatClanker } from '../../src/sidebar/chatClanker';
import { persistedToRuntime, runtimeToPersisted } from '../../src/sidebar/sessionPersistence';
import { openConversationSignature } from '../../src/sidebar/openConversationsPersistence';
import type { ApprovalRequirement } from '../../src/sidebar/approvalKey';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';
import type { ForgeConfig } from '../../src/config/types';

const HOME = 'C:/Users/someone';
const WORKSPACE = 'N:/ws/project';
const env = approvalEnvFor({
  getConfig: () => ({ extra_file_roots: ['N:/Strata'] }) as ForgeConfig,
  workspaceRoot: WORKSPACE,
  home: HOME,
  platform: 'win32',
});
const CTX = env.ctx;

function conversation(rules?: string[]): ConversationRuntime {
  return {
    id: 'chat-9',
    title: 'Rules',
    createdAt: 1,
    updatedAt: 2,
    messages: [{ role: 'assistant', content: 'answer' }],
    ...(rules ? { approval_rules: [...rules] } : {}),
  };
}

function req(key: string, targets?: string[]): ApprovalRequirement {
  return { key, ...(targets ? { targets } : {}) };
}

describe('approvalEnvFor', () => {
  it('names ~/.forge/ an owner-only root and carries the sanctioned roots through', () => {
    expect(CTX.ownerOnly.some((root) => root.includes('.forge'))).toBe(true);
    expect(CTX.extraFileRoots).toEqual(['N:/Strata']);
    expect(CTX.home).toBe(HOME);
    expect(CTX.workspaceRoot).toBe(WORKSPACE);
    expect(env.config?.extra_file_roots).toEqual(['N:/Strata']);
  });
});

describe('allowForChat', () => {
  it('takes a legal key and dedupes it', () => {
    const conv = conversation();
    expect(allowForChat(conv, 'chat-9', 'rdelete:D:/Downloads', CTX)).toBeUndefined();
    expect(chatRules(conv)).toEqual(['rdelete:D:/Downloads']);
    expect(allowForChat(conv, 'chat-9', 'rdelete:D:/Downloads', CTX)).toBeUndefined();
    expect(chatRules(conv)).toEqual(['rdelete:D:/Downloads']);
    expect(allowForChat(conv, 'chat-9', '  cross_chat  ', CTX)).toBeUndefined();
    expect(chatRules(conv)).toEqual(['rdelete:D:/Downloads', 'cross_chat']);
  });

  it('refuses a key that is not a legal one, and stores nothing', () => {
    const conv = conversation();
    const reason = allowForChat(conv, 'chat-9', 'rdelete:C:/Windows/system32', CTX);
    expect(reason).toContain('C:/Windows');
    expect(chatRules(conv)).toEqual([]);
    expect(allowForChat(conv, 'chat-9', `rdelete:${HOME}/.forge/jobs`, CTX)).toContain('.forge');
    expect(allowForChat(conv, 'chat-9', 'nonsense:D:/x', CTX)).toContain('unknown');
    expect(chatRules(conv)).toEqual([]);
  });

  it('stores net:<host> durably and seeds the live fetch store after reload', () => {
    clearConversationHostApprovals('chat-10');
    const conv = conversation();
    conv.id = 'chat-10';
    expect(allowForChat(conv, 'chat-10', 'net:docs.python.org', CTX)).toBeUndefined();
    expect(chatRules(conv)).toEqual(['net:docs.python.org']);
    expect(isHostApproved('chat-10', 'docs.python.org')).toBe(true);
    const saved = runtimeToPersisted(
      { activeConversationId: conv.id, conversations: [conv], history: [] },
      { withHistory: false },
    );
    clearConversationHostApprovals('chat-10');
    expect(isHostApproved('chat-10', 'docs.python.org')).toBe(false);
    const reloaded = persistedToRuntime(saved.conversations[0]!);
    expect(reloaded.approval_rules).toEqual(['net:docs.python.org']);
    expect(isHostApproved('chat-10', 'docs.python.org')).toBe(true);
    // A program key is not a host: the fetch store has no idea what a program is.
    expect(allowForChat(reloaded, 'chat-10', 'net:prog:curl', CTX)).toBeUndefined();
    expect(chatRules(reloaded)).toEqual(['net:docs.python.org', 'net:prog:curl']);
    expect(isHostApproved('chat-10', 'prog')).toBe(false);
    clearConversationHostApprovals('chat-10');
  });

  it('stores and lists the after-secret-read host rule separately', () => {
    const conv = conversation();
    expect(allowForChat(conv, 'chat-secret-net', 'secret-net:a.example', CTX)).toBeUndefined();
    expect(chatRules(conv)).toEqual(['secret-net:a.example']);
    expect(approvalLinesForChat('chat-secret-net', conv)).toEqual([
      'any request to a.example after a secret read  (secret-net:a.example)',
    ]);
  });

  it('lists chat keys and hosts as one rule each', () => {
    const conv = conversation(['cross_chat']);
    markHostApproved(conv.id, 'docs.python.org');
    expect(approvalLinesForChat(conv.id, conv)).toEqual([
      'messages to other chats  (cross_chat)',
      'any request to docs.python.org  (net:docs.python.org)',
    ]);
    clearConversationHostApprovals(conv.id);
  });
});

describe('coveredByChatRules', () => {
  it('is false for a call that has no key, whatever the chat holds', () => {
    const conv = conversation(['cross_chat', 'rdelete:d:/downloads', 'tool:shell', 'net:prog:curl']);
    expect(
      coveredByChatRules(
        conv,
        'chat-9',
        { kind: 'unkeyable', why: 'the deny list always asks' },
        CTX,
        env.config,
      ),
    ).toBe(false);
  });

  it('needs every requirement covered, not just one', () => {
    const conv = conversation(['rdelete:d:/downloads']);
    const both = {
      kind: 'keyed' as const,
      requirements: [
        req('rdelete:d:/downloads', ['d:/downloads/build']),
        req('cross_chat'),
      ],
    };
    expect(coveredByChatRules(conv, 'chat-9', both, CTX, env.config)).toBe(false);
    conv.approval_rules = [...(conv.approval_rules ?? []), 'cross_chat'];
    expect(coveredByChatRules(conv, 'chat-9', both, CTX, env.config)).toBe(true);
  });

  it('answers a net:<host> from the fetch store, including fetch.allowed_hosts', () => {
    clearConversationHostApprovals('chat-11');
    const config = { fetch: { allowed_hosts: ['*.python.org'] } } as ForgeConfig;
    const conv = conversation([]);
    const keys = { kind: 'keyed' as const, requirements: [req('net:docs.python.org')] };
    expect(coveredByChatRules(conv, 'chat-11', keys, CTX, config)).toBe(true);
    expect(coveredByChatRules(conv, 'chat-11', keys, CTX, undefined)).toBe(false);
    markHostApproved('chat-11', 'docs.python.org');
    expect(coveredByChatRules(conv, 'chat-11', keys, CTX, undefined)).toBe(true);
    // A rule that looks like a host key does not cover a different host.
    conv.approval_rules = ['net:pypi.org'];
    clearConversationHostApprovals('chat-11');
    expect(coveredByChatRules(conv, 'chat-11', keys, CTX, undefined)).toBe(false);
  });

  it('will not let a net:<host> rule cover a net:prog: requirement', () => {
    const conv = conversation(['net:curl']);
    const keys = { kind: 'keyed' as const, requirements: [req('net:prog:curl')] };
    expect(coveredByChatRules(conv, 'chat-9', keys, CTX, env.config)).toBe(false);
  });

  it('covers a folder key only when every target is inside it', () => {
    const conv = conversation(['write:N:/Strata']);
    const keys = {
      kind: 'keyed' as const,
      requirements: [req('write:N:/Strata', ['N:/Strata/sub/notes.txt'])],
    };
    expect(coveredByChatRules(conv, 'chat-9', keys, CTX, env.config)).toBe(true);
    expect(
      coveredByChatRules(
        conv,
        'chat-9',
        { kind: 'keyed' as const, requirements: [req('write:N:/Strata', ['N:/Other/x.txt'])] },
        CTX,
        env.config,
      ),
    ).toBe(false);
  });

  it('is false for a chat with no rules at all', () => {
    const keys = { kind: 'keyed' as const, requirements: [req('cross_chat')] };
    expect(coveredByChatRules(conversation(), 'chat-9', keys, CTX, env.config)).toBe(false);
    expect(coveredByChatRules(undefined, 'chat-9', keys, CTX, env.config)).toBe(false);
  });
});

describe('the rules live and die with the conversation', () => {
  it('survives a save and a reload', () => {
    const conv = conversation(['rdelete:D:/Downloads', 'cross_chat', 'net:prog:curl']);
    const session = { activeConversationId: conv.id, conversations: [conv], history: [] };
    const saved = runtimeToPersisted(session, { withHistory: false });
    expect(saved.conversations[0]?.approval_rules).toEqual([
      'rdelete:D:/Downloads',
      'cross_chat',
      'net:prog:curl',
    ]);
    const reloaded = persistedToRuntime(saved.conversations[0]!);
    expect(reloaded.approval_rules).toEqual([
      'rdelete:D:/Downloads',
      'cross_chat',
      'net:prog:curl',
    ]);
    expect(reloaded.approval_rules).not.toBe(conv.approval_rules);
  });

  it('changes the open-chat signature, so a save cannot skip it', () => {
    const conv = conversation();
    const before = openConversationSignature(conv);
    allowForChat(conv, 'chat-9', 'rdelete:D:/Downloads', CTX);
    const after = openConversationSignature(conv);
    expect(after).not.toBe(before);
    clearChatRules(conv);
    expect(openConversationSignature(conv)).not.toBe(after);
  });

  it('/clear empties them', () => {
    const conv = conversation(['rdelete:D:/Downloads', 'cross_chat']);
    clearChatRules(conv);
    expect(chatRules(conv)).toEqual([]);
    const keys = { kind: 'keyed' as const, requirements: [req('cross_chat')] };
    expect(coveredByChatRules(conv, 'chat-9', keys, CTX, env.config)).toBe(false);
  });

  it('Reset approvals clears both host storage and chat rules without changing Clanker', () => {
    const conv = conversation(['cross_chat']);
    conv.clanker = true;
    markHostApproved(conv.id, 'docs.python.org');
    resetChatApprovals(conv);
    expect(chatRules(conv)).toEqual([]);
    expect(isHostApproved(conv.id, 'docs.python.org')).toBe(false);
    expect(conv.clanker).toBe(true);
  });

  it('turning Clanker off does not revoke a chat approval', () => {
    const conv = conversation(['cross_chat']);
    conv.clanker = true;
    clearChatClanker(conv);
    expect(conv.clanker).toBe(false);
    expect(chatRules(conv)).toEqual(['cross_chat']);
  });

  it('a new conversation starts with none', () => {
    expect(conversation().approval_rules).toBeUndefined();
    expect(chatRules(conversation())).toEqual([]);
  });
});
