/**
 * The one check `AgentLoop.runTurn` makes before a turn starts: an image was
 * attached, and the model chosen cannot read images.
 *
 * It lived inside `runTurn` until that file needed the room, and moving it out is
 * not just line arithmetic: the useful part of this check is the three lines of
 * owner-facing wording that say HOW to fix it (`mmproj_path` for llama.cpp, a
 * declared vision capability for the rest), and that wording is easier to read,
 * test and keep honest when it is not buried in the middle of the largest turn
 * method in the file.
 *
 * Pure: it reads the model's declared capabilities and nothing else, and answers
 * with the notice the owner should see plus the outcome the turn should return
 * instead of running. It sends nothing and starts nothing.
 */
import { deriveStaticCapabilities } from '../config/ConfigResolver';
import type { ModelConfig } from '../config/types';
import type { HostToWebview } from './messageBridge';
import type { ForgeTurnOutcome } from './turnOutcome';

/** The refusal for an image sent to a model with no vision capability, or
 *  `undefined` when the turn may run. Both halves come out together on purpose:
 *  the sentence the owner reads and the error the agent gets are the same
 *  complaint, and a version of one that drifts from the other is how a refusal
 *  starts lying about what happened.
 */
export function visionTurnPreflight(
  model: ModelConfig,
  hasImage: boolean,
): { notice: HostToWebview; outcome: ForgeTurnOutcome } | undefined {
  if (!hasImage || deriveStaticCapabilities(model).includes('vision')) return undefined;
  return {
    notice: {
      type: 'error',
      message:
        `Forge: model "${model.name}" is not configured for image input. ` +
        'Choose a vision-capable model. For llama.cpp, set mmproj_path to its compatible ' +
        'projector; for other providers, declare the vision capability only when supported.',
    },
    outcome: {
      kind: 'failed',
      error: `Forge: model "${model.name}" is not configured for image input.`,
      finalText: '',
    },
  };
}
