/**
 * The media half of the two laptop commands
 * (docs/plans/LAPTOP_REMOTE_MEDIA_PLAN.md phase 2).
 *
 * "Forge: Connect to my desktop" already learns which models a desktop serves.
 * This module asks the same desktop one more read — `GET /v1/media/capabilities`
 * — and turns the answer into the two writes the laptop's own media tools need:
 * `remote_media: { enabled: true }`, and the `desktop-relay` group that carries
 * the address if this config does not have one yet.
 *
 * Two rules, both about not inventing a desktop the owner cannot reach:
 *
 * - **Nothing is written for a desktop that serves nothing.** A desktop with no
 *   `cloud_relay.media` block, or one from before this feature, gets no
 *   `remote_media` line: a switch that points at a relay which refuses every
 *   job is worse than no switch, because the next owner has to find the
 *   difference. What it *does* have is the sentence below, in the result message,
 *   naming the desktop's own reason.
 * - **The write is still one write.** The additions land in the same `ConnectPlan`
 *   the model entries do, so `applyConnectPlan` stays the only place a laptop
 *   config is touched, and the "an existing entry is never rewritten" guarantee
 *   still covers the whole run.
 */
import type { RemoteMediaCapabilities } from '../media/remoteMediaContract';
import { REMOTE_MEDIA_TEXT } from '../media/remoteMediaContract';
import type { ForgeConfig } from '../config/types';
import { RemoteMediaRefusedError, fetchCapabilities } from '../tools/remoteMedia/remoteMediaClient';
import { RELAY_GROUPS, relayGroup, type ConnectPlan } from './desktopConnectPlan';

/** The capabilities read: the same 5 s the relay's model-list read gets, because
 *  it is the same machine on the same link. */
const CAPABILITIES_READ_TIMEOUT_MS = 5_000;

/** What to say, whole, when the desktop renders nothing for laptops. It is the
 *  desktop's policy sentence, not a diagnosis of the laptop. */
export const REMOTE_MEDIA_OFF_MESSAGE =
  'Image generation stays on the desktop only: its policy.yaml has no cloud_relay.media block.';

/** The check line's label, so `adviceFor` and the headline name the same thing. */
export const MEDIA_CHECK_LABEL = 'Media on the desktop';

export interface RemoteMediaProbe {
  /** What the desktop will render, or `undefined` when it will not render, or
   *  did not answer. */
  capabilities?: RemoteMediaCapabilities;
  /** What to tell the owner, in one sentence. Never empty. */
  note: string;
}

/** `GET /v1/media/capabilities` against a relay this run already reached. Never
 *  throws: a desktop that does not have the route is the common case, and the
 *  answer to that is a sentence, not an exception. */
export async function probeRemoteMedia(
  fetchImpl: typeof fetch,
  relayUrl: string,
  options: { signal?: AbortSignal } = {},
): Promise<RemoteMediaProbe> {
  try {
    const capabilities = await fetchCapabilities(fetchImpl, relayUrl, {
      timeoutMs: CAPABILITIES_READ_TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!capabilities.tools.length) {
      return {
        note:
          REMOTE_MEDIA_OFF_MESSAGE +
          (capabilities.refused.length ? ` It refuses ${refusedList(capabilities)}.` : ''),
      };
    }
    return {
      capabilities,
      note:
        `The desktop renders ${capabilities.tools.map((tool) => tool.function.name).join(', ')} for this laptop` +
        (capabilities.refused.length ? `; it refuses ${refusedList(capabilities)}.` : ''),
    };
  } catch (error) {
    if (error instanceof RemoteMediaRefusedError && error.message === REMOTE_MEDIA_TEXT.off) {
      return { note: REMOTE_MEDIA_OFF_MESSAGE };
    }
    // A cancelled run propagates: reporting a window that closed as "the desktop
    // has no media" would be a diagnosis the owner could act on by mistake.
    if (options.signal?.aborted) throw error;
    return {
      note:
        `The desktop answered its model list but not its media capabilities (${textOf(error)}), ` +
        'so it cannot be asked to render images from here. Update Forge on the desktop, then run "Forge: Check connection".',
    };
  }
}

/** The desktop's own reasons, as one list — it is the thing the owner most needs
 *  and least expects, and it is the desktop's text, not a guess. */
function refusedList(capabilities: RemoteMediaCapabilities): string {
  return capabilities.refused.map((row) => `${row.name} (${row.reason})`).join(', ');
}

/** The plan's media additions: the switch, and the group that carries the
 *  address when this config does not already have one. Nothing else — an
 *  existing group's endpoint is the owner's, and `planConnect` already left it
 *  alone for the same reason. */
export function mediaConnectAdditions(
  plan: ConnectPlan,
  probe: RemoteMediaProbe,
  relayUrl: string,
  config: ForgeConfig,
): void {
  if (!probe.capabilities?.tools.length) return;
  plan.remoteMedia = { enabled: true };
  const group = RELAY_GROUPS.openai;
  if (config.groups?.[group] || plan.groups[group]) return;
  plan.groups[group] = relayGroup(group, relayUrl);
}

/** One line of "Forge: Check connection": what the desktop can render, why it
 *  cannot, or that the read itself failed. `ok` is false only for a laptop that
 *  asked for media (`remote_media` on) and did not get an answer: a desktop that
 *  renders nothing is a working desktop, and naming it the broken link would
 *  send the owner off to fix a thing that is not broken. */
export async function mediaCheckLine(
  fetchImpl: typeof fetch,
  relayUrl: string,
  laptopWantsMedia: boolean,
  signal?: AbortSignal,
): Promise<{ label: string; ok: boolean; text: string }> {
  const probe = await probeRemoteMedia(fetchImpl, relayUrl, {
    ...(signal ? { signal } : {}),
  });
  const served = probe.capabilities?.tools.length ?? false;
  return {
    label: MEDIA_CHECK_LABEL,
    ok: probe.capabilities !== undefined || !laptopWantsMedia,
    text:
      probe.note +
      (served && !laptopWantsMedia
        ? ' This laptop has remote_media off, so it renders nothing of its own and asks for none.'
        : ''),
  };
}

function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
