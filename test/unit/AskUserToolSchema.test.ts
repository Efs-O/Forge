import { describe, expect, it } from 'vitest';
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
});
