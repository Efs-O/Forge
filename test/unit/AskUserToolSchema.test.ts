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
