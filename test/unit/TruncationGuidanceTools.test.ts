import { describe, expect, it } from 'vitest';
import { ToolCallTruncatedError } from '../../src/llm/ToolCallTruncatedError';
import { truncationGuidance } from '../../src/agent/truncationRecovery';

// The 0.17.196 laptop test cut a `render_html_to_image` call off after 47 bytes
// and told the model to chunk a file: "the \"content\" argument must be at most
// …", "then write_file again with mode \"append\"". That tool has no `content`
// argument and writes nothing the model can append to, so the advice was a
// instruction for a different tool. Only `write_file` (and a cut-off call whose
// tool name never arrived, which is the write-shaped case it was written for)
// keeps the chunking text.

const CEILING = 36000; // Math.max(1000, Math.min(36000, 30000 * 2 - 1000))

describe('truncationGuidance for a tool that is not a file write', () => {
  it('names the tool it cut off and never mentions write_file, "content" or append', () => {
    const guidance = truncationGuidance(
      new ToolCallTruncatedError({ toolName: 'render_html_to_image', approxBytes: 47 }),
      30000,
      CEILING,
    );
    expect(guidance).toBe(
      'Your render_html_to_image call was cut off after 47 bytes of arguments and was NOT executed — nothing ran. The call was cut off before it was complete. The cause is unknown, and nothing was executed.\nHARD LIMIT for your next call: its arguments must total at most 36000 characters. Send the render_html_to_image call again, complete and within that limit.',
    );
    expect(guidance).not.toContain('write_file');
    expect(guidance).not.toContain('"content"');
    expect(guidance).not.toContain('append');
  });

  it('keeps the output-size cause and drops the file-write advice when the reason is length', () => {
    const guidance = truncationGuidance(
      new ToolCallTruncatedError({
        toolName: 'generate_image',
        approxBytes: 512,
        finishReason: 'length',
      }),
      30000,
      CEILING,
    );
    expect(guidance).toContain('output-size limit');
    expect(guidance).toContain('nothing ran');
    expect(guidance).toContain('Send the generate_image call again');
    expect(guidance).not.toContain('write_file');
    expect(guidance).not.toContain('"content"');
    expect(guidance).not.toContain('append');
  });

  it('states the ceiling it computed, not a fixed one', () => {
    const guidance = truncationGuidance(
      new ToolCallTruncatedError({ toolName: 'shell', approxBytes: 9000 }),
      3000,
      24000,
    );
    expect(guidance).toContain('its arguments must total at most 5000 characters.');
  });

  it('tells edit_file to split its edits, not to re-send one call', () => {
    const guidance = truncationGuidance(
      new ToolCallTruncatedError({ toolName: 'edit_file', approxBytes: 9000 }),
      30000,
      CEILING,
    );
    expect(guidance).toContain('Split the edit set across several calls');
    expect(guidance).not.toContain('Send the edit_file call again');
  });
});

describe('truncationGuidance keeps the write-chunking text where it belongs', () => {
  it('write_file still gets the append instruction', () => {
    const guidance = truncationGuidance(
      new ToolCallTruncatedError({ toolName: 'write_file', approxBytes: 40000 }),
      30000,
      CEILING,
    );
    expect(guidance).toContain('write_file again with mode "append"');
    expect(guidance).toContain('the "content" argument must be at most 36000 characters');
  });

  it('a cut-off call with no tool name keeps the write_file advice it was written for', () => {
    const guidance = truncationGuidance(new ToolCallTruncatedError({ approxBytes: 40000 }), 30000, CEILING);
    expect(guidance).toContain('the "content" argument must be at most');
    expect(guidance).toContain('write_file again with mode "append"');
    expect(guidance).toContain('Your last tool call');
  });
});
