/**
 * The single owner of how an `ask_user` answer is written and read back.
 *
 * A question can carry sub-questions, each with its own choice list, and every
 * surface has to agree on two things: how the options are numbered when they
 * are shown as text, and what the assembled answer looks like when it reaches
 * the model. The sidebar dialog, the VS Code input box and the remote chat all
 * resolve through here, so a reply of "1 2" means the same thing whichever one
 * typed it -- and the model reads one answer format regardless.
 */

/** One sub-question: its own prompt, its own mutually exclusive choices. */
export interface QuestionGroup {
  prompt: string;
  options: readonly string[];
}

/** Validates the tool's `questions` arg. Undefined when it is not usable. */
export function parseQuestionGroups(value: unknown): QuestionGroup[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const groups: QuestionGroup[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return undefined;
    const record = item as Record<string, unknown>;
    const prompt = record['prompt'];
    const options = record['options'];
    if (typeof prompt !== 'string' || !prompt.trim()) return undefined;
    if (!Array.isArray(options) || options.length === 0) return undefined;
    if (!options.every((option) => typeof option === 'string')) return undefined;
    groups.push({ prompt, options: options as string[] });
  }
  return groups;
}

/**
 * The assembled answer, one line per sub-question.
 *
 * Labelled rather than bare, because the model has to attribute each choice to
 * the question it answers -- "0.15.35" and "yes" on their own say nothing about
 * which was the version and which was the install.
 */
export function formatGroupAnswer(
  groups: readonly QuestionGroup[],
  picks: readonly string[],
): string {
  return groups.map((group, index) => `${group.prompt}: ${picks[index] ?? ''}`).join('\n');
}

/**
 * Reads a typed reply against the question's shape.
 *
 * Flat options: a bare index picks that option, anything else is verbatim.
 * Sub-questions: one index per sub-question, in order, separated by spaces or
 * commas -- "1 2", "1,2". Anything that is not exactly that many in-range
 * indices is passed through verbatim, so a user who wants to write prose still
 * can and is never told their answer was malformed.
 */
export function resolveAnswerText(
  text: string,
  options?: readonly string[],
  groups?: readonly QuestionGroup[],
): string {
  if (groups?.length) {
    const picks = pickIndices(text, groups);
    return picks ? formatGroupAnswer(groups, picks) : text;
  }
  if (!options?.length) return text;
  const index = /^\s*([0-9]+)\s*$/.exec(text);
  if (!index) return text;
  return options[Number(index[1]) - 1] ?? text;
}

function pickIndices(text: string, groups: readonly QuestionGroup[]): string[] | undefined {
  const tokens = text
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  if (tokens.length !== groups.length) return undefined;
  const picks: string[] = [];
  for (const [index, token] of tokens.entries()) {
    if (!/^[0-9]+$/.test(token)) return undefined;
    const picked = groups[index]?.options[Number(token) - 1];
    if (picked === undefined) return undefined;
    picks.push(picked);
  }
  return picks;
}

/**
 * The question as plain text, for surfaces with no buttons -- a chat message,
 * or the VS Code input box that serves a window whose sidebar never resolved.
 */
export function renderQuestionAsText(
  prompt: string,
  options?: readonly string[],
  groups?: readonly QuestionGroup[],
): string {
  if (groups?.length) {
    const body = groups
      .map(
        (group, index) =>
          `${index + 1}) ${group.prompt}\n` +
          group.options.map((option, i) => `   ${i + 1}. ${option}`).join('\n'),
      )
      .join('\n');
    const example = groups.map(() => '1').join(' ');
    return `${prompt}\n\n${body}\n\nReply with one number per question, in order — e.g. "${example}" — or send free text instead.`;
  }
  if (options?.length) {
    const body = options.map((option, index) => `${index + 1}. ${option}`).join('\n');
    return `${prompt}\n${body}\n\nReply with the number or the text.`;
  }
  return `${prompt}\n\nReply with your answer.`;
}
