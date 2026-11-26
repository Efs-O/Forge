import { describe, expect, it } from 'vitest';
import { ToolCallTruncatedError } from '../../src/llm/ToolCallTruncatedError';
import {
  isLlamaContextExhaustion,
  serverReportedOutputRoom,
  truncationGuidance,
} from '../../src/agent/truncationRecovery';

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

// BL-056: two servers, the same refusal, two positions for the numbers. Both
// were measured here; the second is verbatim from the session log on 2026-11-26
// (maya-glm53-flash-s24, num_ctx 131072 against a server whose real context is
// 98304), and it matched neither matcher, so every turn failed at rounds=0.
const OPENAI_CONTEXT_400 =
  'HTTP 400: {"error": {"type": "invalid_request_error", "message": "maximum context length is 98304 tokens; prompt (21720 tokens) + max tokens (101345) exceeds the context; requests are never truncated", "code": "context_length_exceeded"}}';

// OpenAI's own wording, for the same situation: the prompt fits, only the
// requested output is too big, and the counts arrive in a third shape.
const OPENAI_CHAT_CONTEXT_400 =
  'HTTP 400: {"error": {"message": "This model\'s maximum context length is 8192 tokens. ' +
  'However, you requested 9000 tokens (5000 in the messages, 4001 in the completion). ' +
  'Please reduce the length of the messages or completion.", "type": "invalid_request_error", ' +
  '"code": "context_length_exceeded"}}';

describe('the server\'s own context 400', () => {
  it('reads the room Strata states inside the refusal clause', () => {
    expect(
      serverReportedOutputRoom(
        new Error('prompt (121867 tokens) + max tokens (32768) exceeds the context (154624)'),
      ),
    ).toBe(32757);
  });

  it('reads the room an OpenAI-compatible server states up front', () => {
    expect(serverReportedOutputRoom(new Error(OPENAI_CONTEXT_400))).toBe(76584);
  });

  // Without this one the refusal falls through to isLlamaContextExhaustion and
  // the loop compacts history that fits, to fix a max_tokens that was the only
  // thing too big (Claude's reject of the first BL-056 fix).
  it('reads the room from OpenAI\'s own wording', () => {
    expect(serverReportedOutputRoom(new Error(OPENAI_CHAT_CONTEXT_400))).toBe(3192);
  });

  it('recognises both refusals as context exhaustion', () => {
    expect(isLlamaContextExhaustion(new Error(OPENAI_CONTEXT_400))).toBe(true);
    expect(isLlamaContextExhaustion(new Error(OPENAI_CHAT_CONTEXT_400))).toBe(true);
    expect(
      isLlamaContextExhaustion(
        new Error(
          'HTTP 400: {"error":{"code":400,"message":"request (71277 tokens) exceeds the available context size (62208 tokens), try increasing it","type":"exceed_context_size_error"}}',
        ),
      ),
    ).toBe(true);
  });

  it('leaves an unrelated server error alone', () => {
    expect(serverReportedOutputRoom(new Error('HTTP 500: upstream exploded'))).toBeUndefined();
    expect(isLlamaContextExhaustion(new Error('HTTP 500: upstream exploded'))).toBe(false);
  });
});
