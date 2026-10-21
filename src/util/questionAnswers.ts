/**
 * The single owner of how an `ask_user` question is normalized, displayed and
 * answered. The sidebar, local quick pick and Telegram all use this shape.
 */

export interface QuestionOption {
  label: string;
  description?: string;
  exclusive?: boolean;
  /** Shown as "Recommended" on every surface; the answer is still the bare label. */
  recommended?: boolean;
}

export interface QuestionSpec {
  prompt: string;
  header?: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

export interface QuestionOptionObjectInput {
  label: string;
  description?: string | undefined;
  exclusive?: boolean | undefined;
  recommended?: boolean | undefined;
}

export type QuestionOptionInput = string | QuestionOptionObjectInput;

export interface QuestionSpecInput {
  prompt: string;
  header?: string | undefined;
  multiSelect?: boolean | undefined;
  options: readonly QuestionOptionInput[];
}

export interface QuestionInput {
  prompt?: string | undefined;
  options?: readonly QuestionOptionInput[] | undefined;
  questions?: readonly QuestionSpecInput[] | undefined;
}

/** Compatibility shape for the older grouped-question callers. */
export interface QuestionGroup {
  prompt: string;
  options: readonly string[];
}

export interface StructuredAnswer {
  skipped?: true;
  /** One entry per spec, in the same order. */
  answers: { picks: number[]; note?: string }[];
}

export const QUESTION_SKIP_TEXT =
  'The user skipped this question without answering. Continue with your best judgement and state the assumption you made.';

/** Flat `options` becomes one spec; `questions` becomes one spec per entry. */
export function normalizeQuestions(input: QuestionInput): QuestionSpec[] {
  if (input.questions?.length) {
    return input.questions.map((question) => ({
      prompt: question.prompt,
      ...(question.header === undefined ? {} : { header: question.header }),
      multiSelect: question.multiSelect ?? false,
      options: question.options.map(normalizeOption),
    }));
  }
  if (!input.options?.length) {
    return [{ prompt: input.prompt ?? '', multiSelect: false, options: [] }];
  }
  return [
    {
      prompt: input.prompt ?? '',
      multiSelect: false,
      options: input.options.map(normalizeOption),
    },
  ];
}

function normalizeOption(option: QuestionOptionInput): QuestionOption {
  if (typeof option === 'string') return { label: option };
  const normalized: QuestionOption = { label: option.label };
  if (option.description !== undefined) normalized.description = option.description;
  if (option.exclusive !== undefined) normalized.exclusive = option.exclusive;
  if (option.recommended) normalized.recommended = true;
  return normalized;
}

/** One plain-text option line, shared by every text rendering. */
function optionLine(option: QuestionOption): string {
  const tag = option.recommended ? ' (Recommended)' : '';
  return `${option.label}${tag}${option.description ? ` — ${option.description}` : ''}`;
}

/** Validates and adapts the old string-only `questions` form. */
export function parseQuestionGroups(value: unknown): QuestionGroup[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const specs: QuestionSpecInput[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return undefined;
    const record = item as Record<string, unknown>;
    const prompt = record['prompt'];
    const options = record['options'];
    if (typeof prompt !== 'string' || !prompt.trim()) return undefined;
    if (!Array.isArray(options) || options.length === 0) return undefined;
    if (!options.every((option) => typeof option === 'string')) return undefined;
    specs.push({ prompt, options: options as string[] });
  }
  return normalizeQuestions({ prompt: '', questions: specs }).map((spec) => ({
    prompt: spec.prompt,
    options: spec.options.map((option) => option.label),
  }));
}

/** Resolve the user-facing prompt when an agent omitted the shared preamble. */
export function resolveQuestionText(
  args: { prompt?: unknown; options?: unknown },
  specs?: readonly QuestionSpec[],
): string {
  const preamble = typeof args.prompt === 'string' ? args.prompt.trim() : '';
  if (preamble) return preamble;
  const subQuestion = specs?.find((spec) => spec.prompt.trim())?.prompt.trim();
  if (subQuestion) return subQuestion;
  if (Array.isArray(args.options)) {
    const first = args.options.find((option) => {
      const label = typeof option === 'string' ? option : readOptionLabel(option);
      return label?.trim();
    });
    const label = typeof first === 'string' ? first : readOptionLabel(first);
    if (label) return `Choose one: ${label.trim()}${args.options.length > 1 ? ' …' : ''}`;
  }
  return 'The agent has a question for you (it sent no question text). Reply with your answer.';
}

function readOptionLabel(option: unknown): string | undefined {
  if (typeof option !== 'object' || option === null) return undefined;
  const label = (option as Record<string, unknown>)['label'];
  return typeof label === 'string' ? label : undefined;
}

/** Format indexes as option labels; a written note can accompany the picks. */
export function formatStructuredAnswer(
  specs: readonly QuestionSpec[],
  answer: StructuredAnswer,
): string {
  if (answer.skipped) return QUESTION_SKIP_TEXT;
  if (answer.answers.length !== specs.length) {
    throw new RangeError('Structured answer count must match question count.');
  }
  const formatted = specs.map((spec, specIndex) => {
    const entry = answer.answers[specIndex]!;
    const picks = [...entry.picks].sort((a, b) => a - b);
    const labels = picks.map((index) => {
      const option = spec.options[index];
      if (!Number.isInteger(index) || option === undefined) {
        throw new RangeError(`Question ${specIndex + 1} has an invalid option index.`);
      }
      return option.label;
    });
    const pickedText = labels.join(', ');
    const note = entry.note?.trim() ?? '';
    if (specs.length === 1) {
      if (pickedText && note) return `${pickedText}\nNote: ${note}`;
      return pickedText || note;
    }
    const answerText = pickedText || note;
    return `${spec.prompt}: ${answerText}${pickedText && note ? `\n  Note: ${note}` : ''}`;
  });
  return formatted.join('\n');
}

/**
 * Compatibility wrapper for grouped answers. New callers should pass indexes
 * through `formatStructuredAnswer`.
 */
export function formatGroupAnswer(
  groups: readonly QuestionGroup[],
  picks: readonly string[],
): string {
  const specs = normalizeQuestions({
    prompt: '',
    questions: groups.map((group) => ({
      prompt: group.prompt,
      options: group.options,
    })),
  });
  const answers = specs.map((spec, index) => {
    const pick = picks[index];
    const optionIndex =
      pick === undefined ? undefined : spec.options.findIndex((option) => option.label === pick);
    if (optionIndex !== undefined && optionIndex >= 0) return { picks: [optionIndex] };
    return pick?.trim() ? { picks: [], note: pick } : { picks: [] };
  });
  return formatStructuredAnswer(specs, { answers });
}

/**
 * Resolve typed input with exact labels taking precedence over numeric indexes.
 * A QuestionSpec also enables the multi-select numeric-list form.
 */
export function resolveAnswerText(text: string, spec: QuestionSpec): string;
export function resolveAnswerText(
  text: string,
  options?: readonly QuestionOptionInput[],
  groups?: readonly QuestionGroup[] | readonly QuestionSpec[],
): string;
export function resolveAnswerText(
  text: string,
  optionsOrSpec?: readonly QuestionOptionInput[] | QuestionSpec,
  groups?: readonly QuestionGroup[] | readonly QuestionSpec[],
): string {
  if (isQuestionSpec(optionsOrSpec)) return resolveSpecText(text, optionsOrSpec);
  if (groups?.length) return resolveGroupText(text, groups);
  if (!optionsOrSpec?.length) return text;
  const options = optionsOrSpec.map(normalizeOption);
  return resolveLabelsOrIndexes(text, options, false) ?? text;
}

/** Resolve typed input into option indexes, preserving exact-label precedence. */
export function resolveAnswerPicks(text: string, spec: QuestionSpec): number[] | undefined {
  return resolveOptionPicks(text, spec.options, spec.multiSelect);
}

function isQuestionSpec(value: unknown): value is QuestionSpec {
  return typeof value === 'object' && value !== null && 'multiSelect' in value;
}

function resolveSpecText(text: string, spec: QuestionSpec): string {
  const picks = resolveAnswerPicks(text, spec);
  return picks?.map((index) => spec.options[index]!.label).join(', ') ?? text;
}

function resolveLabelsOrIndexes(
  text: string,
  options: readonly QuestionOption[],
  multiSelect: boolean,
): string | undefined {
  const picks = resolveOptionPicks(text, options, multiSelect);
  return picks?.map((index) => options[index]!.label).join(', ');
}

function resolveOptionPicks(
  text: string,
  options: readonly QuestionOption[],
  multiSelect: boolean,
): number[] | undefined {
  const trimmed = text.trim();
  const exactIndex = options.findIndex(
    (option) => option.label.trim().toLocaleLowerCase() === trimmed.toLocaleLowerCase(),
  );
  if (exactIndex >= 0) return [exactIndex];

  const tokens = multiSelect ? trimmed.split(/[\s,+]+/u).filter(Boolean) : [trimmed];
  if (!tokens.length || tokens.some((token) => !/^\d+$/u.test(token))) return undefined;
  const indexes = tokens.map((token) => Number(token) - 1);
  if (
    indexes.some(
      (index) => !Number.isSafeInteger(index) || index < 0 || options[index] === undefined,
    )
  ) {
    return undefined;
  }
  return [...new Set(indexes)].sort((a, b) => a - b);
}

function resolveGroupText(
  text: string,
  groups: readonly QuestionGroup[] | readonly QuestionSpec[],
): string {
  const specs = groups.map((group) =>
    isQuestionSpec(group)
      ? group
      : {
          prompt: group.prompt,
          multiSelect: false,
          options: group.options.map((label) => ({ label })),
        },
  );
  if (specs.length === 1) {
    const spec = specs[0]!;
    const exact = spec.options.find(
      (option) => option.label.trim().toLocaleLowerCase() === text.trim().toLocaleLowerCase(),
    );
    const tokens = exact
      ? []
      : text
          .trim()
          .split(/[\s,+]+/u)
          .filter(Boolean);
    const indexes = exact
      ? [spec.options.indexOf(exact)]
      : tokens.map((token) => (/^\d+$/u.test(token) ? Number(token) - 1 : -1));
    if (
      !indexes.length ||
      indexes.some(
        (index) => !Number.isSafeInteger(index) || index < 0 || spec.options[index] === undefined,
      )
    ) {
      return text;
    }
    return formatStructuredAnswer(specs, { answers: [{ picks: indexes }] });
  }
  const tokens = text
    .trim()
    .split(/[\s,]+/u)
    .filter(Boolean);
  if (tokens.length !== specs.length) return text;
  const answers: StructuredAnswer['answers'] = [];
  for (const [index, spec] of specs.entries()) {
    const value = resolveLabelsOrIndexes(tokens[index]!, spec.options, false);
    const optionIndex =
      value === undefined ? -1 : spec.options.findIndex((option) => option.label === value);
    if (optionIndex < 0) return text;
    answers.push({ picks: [optionIndex] });
  }
  return formatStructuredAnswer(specs, { answers });
}

/** The plain-text rendering used by Telegram and the local input fallback. */
export function renderQuestionAsText(prompt: string, spec: QuestionSpec): string;
export function renderQuestionAsText(
  prompt: string,
  options?: readonly QuestionOptionInput[],
  groups?: readonly QuestionGroup[] | readonly QuestionSpec[],
): string;
export function renderQuestionAsText(
  prompt: string,
  optionsOrSpec?: readonly QuestionOptionInput[] | QuestionSpec,
  groups?: readonly QuestionGroup[] | readonly QuestionSpec[],
): string {
  if (isQuestionSpec(optionsOrSpec)) return renderSpecAsText(prompt, optionsOrSpec);
  if (groups?.length) {
    const specs: QuestionSpec[] = groups.map((group) =>
      isQuestionSpec(group)
        ? group
        : {
            prompt: group.prompt,
            multiSelect: false,
            options: group.options.map((label) => ({ label })),
          },
    );
    const body = specs
      .map((spec, index) => {
        const optionsText = spec.options
          .map((option, optionIndex) => `   ${optionIndex + 1}. ${optionLine(option)}`)
          .join('\n');
        return `${index + 1}) ${spec.prompt}\n${optionsText}`;
      })
      .join('\n');
    const example = specs.map(() => '1').join(' ');
    const headed = specs.some((spec) => spec.prompt.trim() === prompt.trim())
      ? ''
      : `${prompt}\n\n`;
    return `${headed}${body}\n\nReply with one number per question, in order — e.g. "${example}" — or send free text instead.`;
  }
  if (optionsOrSpec?.length) {
    const normalized = optionsOrSpec.map(normalizeOption);
    const body = normalized
      .map((option, index) => `${index + 1}. ${optionLine(option)}`)
      .join('\n');
    return `${prompt}\n${body}\n\nReply with the number or the text.`;
  }
  return `${prompt}\n\nReply with your answer.`;
}

function renderSpecAsText(prompt: string, spec: QuestionSpec): string {
  if (spec.options.length === 0) return `${prompt}\n\nReply with your answer.`;
  const body = spec.options
    .map((option, index) => `${index + 1}. ${optionLine(option)}`)
    .join('\n');
  const guidance = spec.multiSelect
    ? 'Reply with the numbers, e.g. 1,3, or send free text instead.'
    : 'Reply with the number or the exact text.';
  return `${prompt}\n${spec.multiSelect ? 'Choose any' : 'Choose one'}\n${body}\n\n${guidance}`;
}
