/**
 * Telling the USER why the model cannot see an image.
 *
 * Two different losses, two different remedies, and both must be announced.
 * Silence produces one of two failure modes, neither of which looks like what it
 * is: the model denies seeing a screenshot that is visibly sitting in the
 * transcript above, or it guesses at one and nothing is left to contradict the
 * guess. Both read as a broken model rather than as a config fact or a reload.
 *
 * These are `notice` rows rather than toasts on purpose. A toast is dismissed,
 * missed entirely when the sidebar is not focused, and fires once per session
 * while the confusing behaviour repeats.
 */

import type { HostToWebview } from './messageBridge';
import type { ModelConfig } from '../config/types';
import type { ConversationRuntime } from './sessionTypes';
import { applyCompactionWindow } from './compactionWindow';
import { countImageParts, countReloadDroppedImages } from './imageParts';

interface ImageNoticeDeps {
  /**
   * Already conversation-scoped: AgentLoop stamps `conversationId` onto every
   * message it sends, so callers must not pass one, and must not reach for a
   * second status channel on ModelTurnContext.
   */
  postC: (message: HostToWebview) => void;
  warnOnce: (key: string, message: string) => void;
}

/**
 * The capability case: the images are still in `conv.messages`, the active model
 * just cannot read them. Posted on every turn that actually strips something —
 * the condition is per-turn state, so a suppressed notice on turn 5 is exactly
 * the silent-degradation case this exists to prevent.
 */
function announceVisionStrip(
  conv: ConversationRuntime,
  model: ModelConfig,
  deps: ImageNoticeDeps,
): void {
  // Counted against the FIRST model-facing window: `prepareMessages` re-runs
  // every tool round and would re-post on each. Counting the compacted window
  // rather than all of `conv.messages` also avoids warning about images that
  // compaction had already dropped.
  const stripped = countImageParts(applyCompactionWindow(conv.messages, conv.compaction));
  if (stripped === 0) return;

  deps.postC({
    type: 'notice',
    message:
      `⚠ Forge: "${model.name}" cannot see images. ${stripped} image(s) earlier in this ` +
      'conversation were replaced with a placeholder for this turn. Switch back to a ' +
      'vision-capable model to use them — before reloading the window, as images are not ' +
      `kept across a reload. If "${model.name}" is multimodal, add \`capabilities: [vision]\` ` +
      '(or `mmproj_path` for llama.cpp) to it in config.yaml.',
  });
  // Belt and braces for the user who switched models in the picker and is not
  // reading the transcript yet. The notice is the one that matters.
  deps.warnOnce(
    `${model.name}:vision-strip`,
    `Forge: model "${model.name}" cannot see images; images already in this conversation ` +
      'are being replaced with a placeholder.',
  );
}

/**
 * The reload case, which applies to vision models too: image data is never
 * written to workspaceState, so a restored conversation has notes where its
 * pixels used to be. Unlike the capability case there is no way back, so this is
 * announced once per conversation per session rather than every turn.
 *
 * Unloading a model does not trigger this. Only a window reload, an extension
 * host restart, or reopening the workspace rebuilds a conversation from storage.
 */
function announceReloadLoss(conv: ConversationRuntime, deps: ImageNoticeDeps): void {
  if (conv.imageLossNoticed) return;
  const lost = countReloadDroppedImages(conv.messages);
  if (lost === 0) return;
  conv.imageLossNoticed = true;

  deps.postC({
    type: 'notice',
    message:
      `⚠ Forge: ${lost} image(s) in this conversation were lost when the window reloaded. ` +
      'Image data is never written to workspace storage, so it cannot be restored and no ' +
      'model can see it now — switching models will not bring it back. Re-attach the image, ' +
      'or call view_image again, if this turn needs it.',
  });
}

/**
 * Both scans run once per turn, before the tool-calling loop, and are disjoint
 * by construction: a live transcript holds real `image_url` parts and no persist
 * notes, while a restored one holds notes and no parts.
 */
export function announceMissingImages(
  conv: ConversationRuntime,
  model: ModelConfig,
  isVisionModel: boolean,
  deps: ImageNoticeDeps,
): void {
  // A non-vision model cannot introduce image parts later in the turn:
  // view_image/view_video are withheld from its tool list AND refused at
  // dispatch, so one scan up front is enough.
  if (!isVisionModel) announceVisionStrip(conv, model, deps);
  announceReloadLoss(conv, deps);
}
