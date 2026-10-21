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
      description: z.string().max(200).optional(),
      exclusive: z.boolean().optional(),
    })
    .strict(),
]);

const questionSpecSchema = z
  .object({
    prompt: z.string(),
    header: z.string().max(16).optional(),
    multiSelect: z.boolean().optional(),
    options: z.array(questionOptionSchema).min(2).max(9),
  })
  .strict();

const askUserArgsSchema = z
  .object({
    prompt: z.string().optional(),
    placeholder: z.string().optional(),
    options: z.array(questionOptionSchema).min(2).max(9).optional(),
    questions: z.array(questionSpecSchema).min(1).max(4).optional(),
  })
  .strict();

const questionOptionJsonSchema = {
  anyOf: [
    { type: 'string', maxLength: 80 },
    {
      type: 'object',
      properties: {
        label: { type: 'string', maxLength: 80 },
        description: { type: 'string', maxLength: 200 },
        exclusive: { type: 'boolean' },
      },
      required: ['label'],
      additionalProperties: false,
    },
  ],
};

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
          'as exclusive. The user can always add a note or write their own answer; ' +
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
      const parsed = askUserArgsSchema.parse(args);
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
