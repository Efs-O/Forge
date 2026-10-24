import { describe, expect, it } from 'vitest';
import {
  formatChatId,
  formatChatList,
  resolveChatReference,
  type ChatRef,
} from '../../src/tools/chatMessageResolver';

const chats: ChatRef[] = [
  { id: 'self-id-0001', title: 'Current work', position: 1, running: true, model: 'strata' },
  { id: 'bug-hunt-0002', title: 'Bug hunt', position: 2, running: true, model: 'strata' },
  { id: 'notes-0003', title: 'Release notes', position: 3, running: false },
];

function chosen(ref: string | undefined, values = chats): ChatRef {
  const result = resolveChatReference(ref, values, 'self-id-0001');
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.chat;
}

describe('resolveChatReference', () => {
  it('resolves exact ids before all other tiers', () => {
    expect(chosen('bug-hunt-0002').id).toBe('bug-hunt-0002');
  });

  it('resolves #N and bare N as 1-based tab positions', () => {
    expect(chosen('#2').id).toBe('bug-hunt-0002');
    expect(chosen('3').id).toBe('notes-0003');
  });

  it('prefers an exact id over a numeric tab position', () => {
    const values = [
      { id: '2', title: 'Numeric id', position: 1, running: false },
      { id: 'other', title: 'Second tab', position: 2, running: false },
    ];
    const result = resolveChatReference('2', values, 'not-open');
    expect(result).toEqual({ ok: true, chat: values[0] });
  });

  it('resolves id prefixes only when they have at least four characters', () => {
    expect(chosen('bug-').id).toBe('bug-hunt-0002');
    const shortChats = chats.map((chat) =>
      chat.id === 'bug-hunt-0002' ? { ...chat, title: 'Parser issue' } : chat,
    );
    const short = resolveChatReference('bug', shortChats, 'self-id-0001');
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.reason).toContain('No open chat matches');
  });

  it('refuses an ambiguous id prefix with only that tier’s candidates', () => {
    const values: ChatRef[] = [
      { id: 'self', title: 'Caller', position: 1, running: false },
      { id: 'task-1111', title: 'First task', position: 2, running: false },
      { id: 'task-2222', title: 'Second task', position: 3, running: false },
      { id: 'third', title: 'Task notes', position: 4, running: false },
    ];
    const result = resolveChatReference('task-', values, 'self');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.candidates.map((chat) => chat.id)).toEqual(['task-1111', 'task-2222']);
      expect(result.reason).toContain('#2 "First task"');
      expect(result.reason).toContain('#3 "Second task"');
      expect(result.reason).not.toContain('Task notes');
    }
  });

  it('resolves exact normalized titles before substring matches', () => {
    const values: ChatRef[] = [
      { id: 'self', title: 'Caller', position: 1, running: false },
      { id: 'one', title: 'Review', position: 2, running: false },
      { id: 'two', title: 'Review the parser', position: 3, running: false },
    ];
    expect(resolveChatReference('  "REVIEW"  ', values, 'self')).toEqual({
      ok: true,
      chat: values[1],
    });
  });

  it('resolves a title substring', () => {
    expect(chosen('lease not').id).toBe('notes-0003');
  });

  it('matches every title word or prefix after dropping filler words', () => {
    const values: ChatRef[] = [
      { id: 'self', title: 'Caller', position: 1, running: false },
      { id: 'pagoda', title: 'Pagoda refactor', position: 2, running: false },
    ];
    expect(resolveChatReference('the pagoda session refac', values, 'self')).toEqual({
      ok: true,
      chat: values[1],
    });
  });

  it('treats omitted, blank, quoted filler-only and “other chat” references alike', () => {
    expect(chosen(undefined).id).toBe('bug-hunt-0002');
    expect(chosen('   ').id).toBe('bug-hunt-0002');
    expect(chosen('"other chat"').id).toBe('bug-hunt-0002');
    expect(chosen('the running session').id).toBe('bug-hunt-0002');
  });

  it('uses the only other open chat when no other chat is running', () => {
    const values = chats
      .filter((chat) => chat.id !== 'notes-0003')
      .map((chat) => ({ ...chat, running: false }));
    const result = resolveChatReference(undefined, values, 'self-id-0001');
    expect(result).toEqual({ ok: true, chat: values[1] });
  });

  it('refuses omitted references when several other chats are open', () => {
    const values = chats.map((chat) => ({ ...chat, running: false }));
    const result = resolveChatReference(undefined, values, 'self-id-0001');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('Several other chats');
      expect(result.candidates.map((chat) => chat.id)).toEqual(['bug-hunt-0002', 'notes-0003']);
    }
  });

  it('refuses omitted references when no other chat is open', () => {
    const result = resolveChatReference(undefined, [chats[0]!], 'self-id-0001');
    expect(result).toMatchObject({ ok: false, candidates: [] });
  });

  it('refuses a reference that matches only the caller as “that is this chat”', () => {
    const result = resolveChatReference('Current work', chats, 'self-id-0001');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('That is this chat');
  });

  it('falls through a tier that matched only the caller to the next tier', () => {
    // Exact title "Parser" is the caller; the substring tier finds "Parser fixes".
    const values: ChatRef[] = [
      { id: 'self-id-0001', title: 'Parser', position: 1, running: true },
      { id: 'other-0002', title: 'Parser fixes', position: 2, running: true },
      { id: 'notes-0003', title: 'Notes', position: 3, running: false },
    ];
    expect(chosen('parser', values).id).toBe('other-0002');
  });

  it('resolves a symbol-only reference by title instead of treating it as omitted', () => {
    const values: ChatRef[] = [
      ...chats,
      { id: 'rocket-0004', title: '🚀', position: 4, running: false },
    ];
    expect(chosen('🚀', values).id).toBe('rocket-0004');
    const missing = resolveChatReference('🛸', values, 'self-id-0001');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toContain('No open chat matches');
  });

  it('returns all other chats on no match so the caller can show the full list', () => {
    const result = resolveChatReference('nonexistent', chats, 'self-id-0001');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('No open chat matches');
      expect(result.candidates.map((chat) => chat.id)).toEqual(['bug-hunt-0002', 'notes-0003']);
    }
  });
});

describe('formatChatList', () => {
  it('prints tab-order lines, marks the caller, and shortens long UUIDs to unique prefixes', () => {
    const values: ChatRef[] = [
      {
        id: '12345678-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        title: 'Second chat',
        position: 2,
        running: false,
      },
      {
        id: '12345678-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        title: 'First chat',
        position: 1,
        running: true,
        model: 'strata-flash',
      },
    ];
    const result = formatChatList(values, values[1]!.id);
    expect(result).toContain('Chats in this window (you are #1):');
    expect(result.indexOf('#1 · First chat')).toBeLessThan(result.indexOf('#2 · Second chat'));
    expect(result).toContain('#1 · First chat · running · strata-flash · id 12345678-b ← you');
    expect(result).toContain('#2 · Second chat · idle · id 12345678-a');
    expect(formatChatId('short-id', values)).toBe('short-id');
  });
});
