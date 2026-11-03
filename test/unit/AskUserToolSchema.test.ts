import { describe, expect, it, vi } from 'vitest';
import { UserQuestionService } from '../../src/sidebar/UserQuestionService';
import { makeAskUserTool } from '../../src/tools/askUserTool';

describe('ask_user schema', () => {
  const tool = makeAskUserTool(new UserQuestionService());

  it('keeps the nested schema strict and applies the planned limits', () => {
    const parameters = tool.definition.function.parameters as {
      additionalProperties: boolean;
      properties: {
        questions: {
          maxItems: number;
          items: {
            properties: {
              header: { maxLength: number };
              options: { maxItems: number; minItems: number; items: unknown };
            };
          };
        };
      };
    };

    expect(parameters.additionalProperties).toBe(false);
    expect(parameters.properties.questions.maxItems).toBe(4);
    expect(parameters.properties.questions.items.properties.header.maxLength).toBe(16);
    expect(parameters.properties.questions.items.properties.options).toMatchObject({
      minItems: 2,
      maxItems: 9,
    });
  });

  it('rejects unknown fields before creating a pending question', async () => {
    await expect(
      tool.handler({ prompt: 'Question?', hidden: true }, { beforeMutate: () => undefined }),
    ).rejects.toThrow();
    expect(new UserQuestionService().pendingQuestions()).toEqual([]);
  });

  it('guides the model to use exclusivity and notes without an Other option', () => {
    const description = tool.definition.function.description;
    expect(description).toContain('Mark an option');
    expect(description).toContain('exclusive');
    expect(description).toContain('add a note');
    expect(description).toContain('do not add an “Other” option');
  });

  it('passes a recommended option through in the order the agent sent', () => {
    const service = new UserQuestionService();
    const asked = vi.fn();
    service.addSink({ asked, answered: () => undefined });
    void makeAskUserTool(service).handler(
      {
        prompt: 'Bump the version?',
        options: ['Keep 0.17.59', { label: 'Bump to 0.17.60', recommended: true }],
      },
      { beforeMutate: () => undefined, conversationId: 'c1' },
    );
    expect(asked.mock.calls[0]?.[0].specs[0].options).toEqual([
      { label: 'Keep 0.17.59' },
      { label: 'Bump to 0.17.60', recommended: true },
    ]);
  });

  it('allows one recommendation per single-select question and several in multiSelect', async () => {
    const two = [
      { label: 'A', recommended: true },
      { label: 'B', recommended: true },
    ];
    const context = { beforeMutate: () => undefined };
    await expect(tool.handler({ prompt: 'Pick', options: two }, context)).rejects.toThrow(
      /recommend only one option/,
    );
    await expect(
      tool.handler({ questions: [{ prompt: 'Pick', options: two }] }, context),
    ).rejects.toThrow(/recommend only one option/);

    const service = new UserQuestionService();
    const asked = vi.fn();
    service.addSink({ asked, answered: () => undefined });
    void makeAskUserTool(service).handler(
      { questions: [{ prompt: 'Pick', multiSelect: true, options: two }] },
      context,
    );
    expect(asked).toHaveBeenCalledOnce();
  });

  it('tells the model to flag the recommendation instead of writing it into the label', () => {
    const description = tool.definition.function.description;
    expect(description).toContain('recommended: true');
    expect(description).toContain('do not write "recommended" into the label');
  });
});

/**
 * Lane 5 phase 5.5 (docs/plans/V1_FINISH_PLAN.md): eleven of 59 audited
 * `ask_user` calls were refused over their arguments, and four put the question
 * text in the top-level `prompt` while leaving the `questions` entries without
 * their own — the shape a single question actually needs, written one level too
 * high. One such question now borrows the shared text; two of them is a real
 * disagreement about which text belongs to which question, so the call is refused
 * with the shape shown instead of a guess.
 */
describe('ask_user question prompts', () => {
  const context = { beforeMutate: vi.fn(), conversationId: 'c1' };

  function rig(): {
    tool: ReturnType<typeof makeAskUserTool>;
    asked: ReturnType<typeof vi.fn>;
    service: UserQuestionService;
  } {
    const service = new UserQuestionService();
    const asked = vi.fn();
    service.addSink({ asked, answered: () => undefined });
    return { tool: makeAskUserTool(service), asked, service };
  }

  it('the only question with no prompt borrows the shared top-level text', async () => {
    const { tool, asked } = rig();
    // Not awaited: ask_user blocks until the user answers, and this fake never
    // answers. The card is what is being checked, and it is built synchronously.
    void tool.handler(
      {
        prompt: 'Which build should I run?',
        questions: [
          { options: ['Fast', 'Full'] },
          { prompt: 'Bump the version?', options: ['Yes', 'No'] },
        ],
      },
      context,
    );
    expect(asked).toHaveBeenCalledOnce();
    const askedCall = asked.mock.calls[0]?.[0] as {
      prompt: string;
      specs: Array<{ prompt: string }>;
    };
    expect(askedCall.specs.map((spec) => spec.prompt)).toEqual([
      'Which build should I run?',
      'Bump the version?',
    ]);
    // The shared text is still the heading, so the card does not show the same
    // sentence twice in different places.
    expect(askedCall.prompt).toBe('Which build should I run?');
  });

  it('two questions with no prompt are refused with the shape, not a guess', async () => {
    const { tool, asked, service } = rig();
    let refusal = '';
    try {
      await tool.handler(
        {
          prompt: 'Two decisions',
          questions: [{ options: ['a', 'b'] }, { options: ['c', 'd'] }],
        },
        context,
      );
    } catch (error) {
      refusal = (error as Error).message;
    }
    expect(refusal).toContain('questions[0], questions[1] are missing "prompt"');
    expect(refusal).toContain('Each question needs its own "prompt"');
    expect(refusal).toContain('the top-level "prompt" is only a shared intro');
    expect(refusal).toContain('{"questions":[{"prompt":"Which build?","options":["Fast","Full"]}]}');
    expect(asked).not.toHaveBeenCalled();
    expect(service.pendingQuestions()).toEqual([]);
  });

  it('one question with no prompt and no shared text is refused the same way', async () => {
    const { tool, asked } = rig();
    let refusal = '';
    try {
      await tool.handler({ questions: [{ options: ['a', 'b'] }] }, context);
    } catch (error) {
      refusal = (error as Error).message;
    }
    expect(refusal).toContain('questions[0] is missing "prompt"');
    expect(refusal).toContain('Each question needs its own "prompt"');
    expect(asked).not.toHaveBeenCalled();
  });

  it('an over-long option description is refused, never silently shortened', async () => {
    // The description is what the user reads. Trimming it to make the call pass
    // would change the question without anyone noticing, so the limit stays and
    // the refusal is the fix — see the plain-line formatter in toolErrorText.
    const { tool, asked } = rig();
    const long = 'z'.repeat(512);
    await expect(
      tool.handler(
        {
          prompt: 'Deploy?',
          questions: [{ prompt: 'Which?', options: [{ label: 'a', description: long }, 'b'] }],
        },
        context,
      ),
    ).rejects.toThrow();
    expect(asked).not.toHaveBeenCalled();
  });

  it('accepts a 500-character description, which is the whole point of the limit', () => {
    // The limit was 200 and the refusals it caused were four calls in one chat
    // (205, 216, 351, 376 characters): a reason that has to say why one option is
    // safer than another needs more than 200 characters. 500 is what the schema
    // now declares, so exactly 500 reaches the user rather than being refused.
    // Not awaited past the first await: the question service waits for an answer
    // that will not come in a unit test, so the sink is read synchronously — the
    // same shape the recommendation test above uses.
    const service = new UserQuestionService();
    const asked = vi.fn();
    service.addSink({ asked, answered: () => undefined });
    void makeAskUserTool(service).handler(
      {
        prompt: 'Deploy?',
        questions: [
          { prompt: 'Which?', options: [{ label: 'a', description: 'z'.repeat(500) }, 'b'] },
        ],
      },
      { beforeMutate: () => undefined, conversationId: 'c1' },
    );
    expect(asked.mock.calls[0]?.[0].specs[0].options).toEqual([
      { label: 'a', description: 'z'.repeat(500) },
      { label: 'b' },
    ]);
  });
});
