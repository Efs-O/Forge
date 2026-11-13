import type { ModelConfig } from '../config/types';
import {
  ALL_FORMS,
  MARKER_FORMS,
  NO_FORMS,
  type StructuredOutputForms,
} from './StructuredOutputParser';

/**
 * Which shapes Forge may read a tool call out of, for one round's response.
 *
 * A round that OFFERED native tools never taught the model the fenced-JSON
 * format (`buildRoundRequest` adds `withFallbackToolInstructions` only when no
 * native definitions are sent), so a ```json block naming a real tool in that
 * answer is an example the model is showing the user, not a request. Dispatching
 * it was the High finding in the harness audit (F1): "here is how I would fix
 * it" ran a real `write_file`.
 *
 * The provider markers stay readable in a native round on purpose. llama-server
 * parses only its template's own `<function=...>` form, and Qwen-family
 * fine-tunes drift into `<tool_call>{...}</tool_call>` as content after a few
 * native calls — that channel is how those calls still run. A user who wants
 * native events only sets `text_tool_calls: native` on the model.
 */
export function textToolCallForms(
  model: Pick<ModelConfig, 'text_tool_calls'> | undefined,
  usedNativeTools: boolean,
): StructuredOutputForms {
  switch (model?.text_tool_calls) {
    case 'text':
      // Explicit opt-in: this backend never emits native calls, so text is its
      // only channel even when Forge offered tools it will ignore.
      return ALL_FORMS;
    case 'native':
      return NO_FORMS;
    default:
      return usedNativeTools ? MARKER_FORMS : ALL_FORMS;
  }
}
