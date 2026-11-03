import { z } from 'zod';
import { normalizeQuestions, resolveQuestionText } from '../util/questionAnswers';
import type { UserQuestionService } from '../sidebar/UserQuestionService';
import {
  unattendedConversations,
  type UnattendedConversationRegistry,
} from '../sidebar/unattendedConversations';
import type { RegisteredTool } from './ToolRegistry';

const questionOptionSchema = z.union([
  z.string().max(80),
  z
    .object({
      label: z.string().max(80),
      description: z.string().max(500).optional(),
      exclusive: z.boolean().optional(),
      recommended: z.boolean().optional(),
    })
    .strict(),
]);

const optionListSchema = z.array(questionOptionSchema).min(2).max(9);

function recommendedCount(options: readonly z.infer<typeof questionOptionSchema>[]): number {
  return options.filter((option) => typeof option !== 'string' && option.recommended).length;
}

const ONE_RECOMMENDED =
  'A single-select question can recommend only one option; use multiSelect to recommend a combination.';

const questionSpecSchema = z
  .object({
    prompt: z.string(),
    header: z.string().max(16).optional(),
    multiSelect: z.boolean().optional(),
    options: optionListSchema,
  })
  .strict()
  .refine((spec) => spec.multiSelect || recommendedCount(spec.options) <= 1, {
    message: ONE_RECOMMENDED,
    path: ['options'],
  });

const askUserArgsSchema = z
  .object({
    prompt: z.string().optional(),
    placeholder: z.string().optional(),
    options: optionListSchema.optional(),
    questions: z.array(questionSpecSchema).min(1).max(4).optional(),
  })
  .strict()
  .refine((args) => recommendedCount(args.options ?? []) <= 1, {
    message: ONE_RECOMMENDED,
    path: ['options'],
  });

const questionOptionJsonSchema = {
  anyOf: [
    { type: 'string', maxLength: 80 },
    {
      type: 'object',
      properties: {
        label: { type: 'string', maxLength: 80 },
        description: { type: 'string', maxLength: 500 },
        exclusive: { type: 'boolean' },
        recommended: {
          type: 'boolean',
          description: 'The option you recommend; one per single-select question.',
        },
      },
      required: ['label'],
      additionalProperties: false,
    },
  ],
};

/**
 * One question with no `prompt` borrows the shared top-level one.
 *
 * Eleven of 59 audited `ask_user` calls (2026-10-27) were refused over their
 * arguments, and four of them put the question text in the top-level `prompt`
 * and left the `questions` entries without their own — the model meant exactly
 * what a single question needs, and the call died on a field it had written one
 * level too high. A second shape, `questions` arriving as a string of
 * hand-written JSON, is already handled ahead of here: the registry parses a
 * string array before the call reaches this handler.
 *
 * Two questions with no prompt is a real disagreement about which text belongs
 * to which question, so the call is refused with the shape shown instead of
 * guessing. An over-long option description is NOT repaired: the text is what
 * the user reads, so shortening it silently would change the question, and the
 * plain-line refusal (`toolErrorText.ts`) is the fix.
 */
function questionPromptRepair(
  args: Record<string, unknown>,
): { args: Record<string, unknown> } | { refusal: string } {
  const questions = args['questions'];
  if (!Array.isArray(questions)) return { args };
  const missing = questions
    .map((question, index) => ({ question, index }))
    .filter(
      ({ question }) =>
        question !== null &&
        typeof question === 'object' &&
        !Array.isArray(question) &&
        (question as Record<string, unknown>)['prompt'] === undefined,
    )
    .map(({ index }) => index);
  if (missing.length === 0) return { args };
  const shared = typeof args['prompt'] === 'string' ? args['prompt'].trim() : '';
  if (missing.length === 1 && shared) {
    const at = missing[0]!;
    const filled = [...questions];
    filled[at] = { ...(filled[at] as Record<string, unknown>), prompt: args['prompt'] };
    return { args: { ...args, questions: filled } };
  }
  const where = `questions[${missing.join('], questions[')}]`;
  return {
    refusal:
      `ask_user ${where} ${missing.length === 1 ? 'is' : 'are'} missing "prompt". ` +
      'Each question needs its own "prompt"; the top-level "prompt" is only a shared intro. ' +
      'Resend as: {"questions":[{"prompt":"Which build?","options":["Fast","Full"]}]}',
  };
}

/** Ask the user and wait for a response, using the shared question contract. */
export function makeAskUserTool(
  questions: UserQuestionService,
  unattended: UnattendedConversationRegistry = unattendedConversations,
): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'ask_user',
        description:
          'Ask the user a question and BLOCK until they answer, with no timeout -- ' +
          'do not use it to check in during unattended work; when work can continue ' +
          'under a stated assumption, state it, notify_user, and keep going. Keep ' +
          'options short. For related decisions in one round, pass `questions` rather ' +
          'than one combined options list: each entry carries its own prompt and ' +
          'options, and the top-level prompt only heads them. Use multiSelect only ' +
          'when the choices can be combined; choices that contradict each other ' +
          'belong in a single-select question. Mark an option such as "None of these" ' +
          'as exclusive. Mark the option you recommend with recommended: true, list it ' +
          'first, and put the reason in its description; do not write "recommended" into ' +
          'the label. The user can always add a note or write their own answer; ' +
          'do not add an “Other” option.',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Question or shared prompt shown to the user.' },
            placeholder: {
              type: 'string',
              description: 'Placeholder text for a free-text input box.',
            },
            options: {
              type: 'array',
              minItems: 2,
              maxItems: 9,
              items: questionOptionJsonSchema,
              description:
                'Choices for one single-select question. Ignored when `questions` is present.',
            },
            questions: {
              type: 'array',
              minItems: 1,
              maxItems: 4,
              description:
                'Up to four questions answered in one round, each with its own choice ' +
                'list. The answer comes back as one labelled line per question. Use ' +
                '`prompt` as the shared preamble.',
              items: {
                type: 'object',
                properties: {
                  prompt: { type: 'string', description: 'This question.' },
                  header: { type: 'string', maxLength: 16, description: 'Short tab label.' },
                  multiSelect: {
                    type: 'boolean',
                    description: 'Use only when the choices can be combined.',
                  },
                  options: {
                    type: 'array',
                    minItems: 2,
                    maxItems: 9,
                    items: questionOptionJsonSchema,
                  },
                },
                required: ['prompt', 'options'],
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args, context) => {
      const call = questionPromptRepair(args);
      // Thrown, not returned: `ToolDispatch` prefixes `Error:` and counts a thrown
      // refusal in the consecutive-failure streak that can strip a model's tools,
      // so a returned string would silently stop these calls from counting.
      if ('refusal' in call) throw new Error(call.refusal);
      const parsed = askUserArgsSchema.parse(call.args);
      if (context?.conversationId && unattended.has(context.conversationId)) {
        return (
          'unattended: no user present — Nobody is attending this job run, so no answer will come. ' +
          'Make the safest assumption and continue, or stop and report RESULT: failed with the question.'
        );
      }
      const specs = normalizeQuestions(parsed);
      const prompt = resolveQuestionText(parsed, specs);
      const questionSpecs = specs.map((spec, index) =>
        index === 0 && !spec.prompt.trim() ? { ...spec, prompt } : spec,
      );
      const answer = await questions.ask({
        prompt,
        placeholder: parsed.placeholder,
        specs: questionSpecs,
        conversationId: context?.conversationId,
        signal: context?.abortSignal,
      });
      return (
        answer ??
        'The user did not answer: the question was dismissed without a response. ' +
          'Do not call ask_user again for this question -- ask it in your chat reply and end the turn.'
      );
    },
  };
}
