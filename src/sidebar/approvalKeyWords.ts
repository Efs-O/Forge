/**
 * What an approval key says in plain words: the line the owner reads on the card
 * (`Allow for this chat covers: any request to huggingface.co.`), the same words
 * `/approvals` lists, and the same words the Telegram card and its receipt carry.
 *
 * One table for three surfaces, because a key is only worth having if the owner
 * can see what they allowed. The card, the chat rule, the `gate` row and
 * `/approvals` all name the same string; this is the only place that turns it
 * back into language a person reads, so a card cannot promise "any request to
 * huggingface.co" while the rule the click stored said something wider, and a
 * later reader cannot be shown a sentence the owner never saw.
 *
 * Pure and table-driven: the words follow the key, and a key that is not in the
 * table prints ITSELF rather than a guess, so a key a later phase adds (or one
 * typed into `policy.yaml` by hand) still shows up truthfully before anything
 * here knows what it means.
 */
import {
  DELEGATE_KEY,
  NET_KEY,
  NET_PROG_KEY,
  RDELETE_KEY,
  SECRET_KEY,
  TOOL_KEY,
  WRITE_KEY,
} from './approvalKeyGrammar';

/** Keys that are whole strings rather than a prefix plus a value, so they match
 *  exactly and have nothing to name after a colon. */
const WORDS_FOR_EXACT_KEY: Readonly<Record<string, string>> = {
  cross_chat: 'messages to other chats',
};

/** The rows that name something after their prefix. Longest prefix first:
 *  `net:prog:` has to be tried before `net:`, or a program would read as a host
 *  and the card would say `any request to prog:curl`. */
const WORDS_BY_PREFIX: ReadonlyArray<{ prefix: string; words: (value: string) => string }> = [
  { prefix: NET_PROG_KEY, words: (program) => `network commands run with ${program}` },
  { prefix: NET_KEY, words: (host) => `any request to ${host}` },
  { prefix: DELEGATE_KEY, words: (agent) => `asking ${agent}` },
  { prefix: WRITE_KEY, words: (root) => `writes inside ${root}` },
  { prefix: SECRET_KEY, words: (file) => `reading ${file}` },
  { prefix: TOOL_KEY, words: (name) => `the ${name} tool` },
  { prefix: RDELETE_KEY, words: (folder) => `recursive deletes inside ${folder}` },
];

/** The plan §2 key table, row by row. A key that is not in it prints itself. */
export function describeApprovalKey(key: string): string {
  const value = key.trim();
  const exact = WORDS_FOR_EXACT_KEY[value];
  if (exact !== undefined) return exact;
  for (const row of WORDS_BY_PREFIX) {
    if (!value.startsWith(row.prefix)) continue;
    const named = value.slice(row.prefix.length).trim();
    // A key that names nothing (`net:`, `tool:`) can never be allowed, so the
    // card shows the raw key instead of a sentence with a blank where the name
    // should have been.
    return named.length === 0 ? value : row.words(named);
  }
  return value;
}

/** Several keys in the order the call needs them: `, ` between them and ` and `
 *  before the last, because that is how the sentence a person has to read reads. */
export function describeApprovalKeys(keys: readonly string[]): string {
  const described = keys.map((key) => describeApprovalKey(key));
  if (described.length === 0) return '';
  const last = described[described.length - 1]!;
  if (described.length === 1) return last;
  return `${described.slice(0, -1).join(', ')} and ${last}`;
}
