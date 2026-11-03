import type { ForgeConfig } from '../config/types';
import type { RemoteAuth } from './RemoteAuth';
import {
  buildRemoteControllerOptions,
  transportNames,
  type RemoteControllerOptionsDeps,
} from './remoteControllerOptions';
import { voiceRuntimeSignature } from './voiceRuntimeSignature';
import type { ActiveTransport } from './RemoteTransportManager';

/**
 * The two halves of a config reload that does **not** restart the transports:
 * deciding whether one is possible, and pushing the new config into the
 * transports already running.
 *
 * They live here for two reasons. They read only their arguments — no runtime
 * state, no lifecycle chain, nothing to serialize — so they are the part of
 * `RemoteRuntime` that can leave without changing behaviour; and `RemoteRuntime`
 * is at the ESLint `max-lines` stop, and phase 3 of
 * `docs/plans/TELEGRAM_WORKSPACE_SWITCH_SAFETY_PLAN.md` has to add the window
 * files, the cap and the Close watch to it. The plan names that limit itself
 * ("`RemoteRuntime.ts` (496, and its switch body is extracted)"), so the room
 * comes from here rather than from cramming new logic into the runtime.
 */

/** True when the transports already running can absorb this config instead of
 *  being stopped and started again: the same channels in the same order, and a
 *  voice runtime that does not need rebuilding.
 *
 *  `appliedConfig` is the config those transports were started from, so its
 *  absence means this is a first start (nothing to update), and a disposed
 *  window is never updated in place — it is on its way out, and a reload that
 *  reached it would restart transports it has already stopped. */
export function canUpdateTransportsInPlace(
  config: ForgeConfig,
  appliedConfig: ForgeConfig | undefined,
  isDisposed: boolean,
  activeNames: string[],
): boolean {
  if (!appliedConfig || isDisposed) return false;
  const configured = transportNames(config);
  return (
    configured.length === activeNames.length &&
    configured.every((name, index) => name === activeNames[index]) &&
    voiceRuntimeSignature(config) === voiceRuntimeSignature(appliedConfig)
  );
}

/** Apply a reloaded config to the transports already running: the TOTP session
 *  policy, each controller's options, and the spoken-reply toggle. Idempotent,
 *  and a no-op when `config` has no `remote` block at all — a config that
 *  cannot describe a transport cannot update one.
 *
 *  Takes the pieces rather than the runtime, so the caller keeps owning the
 *  lifecycle chain and this stays a pure push over whatever is active at call
 *  time (`manager.values()`, read then, not captured earlier). */
export function updateActiveTransportOptions(
  config: ForgeConfig,
  auth: RemoteAuth,
  transports: Iterable<ActiveTransport>,
  deps: RemoteControllerOptionsDeps,
): void {
  if (!config.remote) return;
  auth.updateSessionPolicy({
    inactivityTimeoutMinutes: config.remote.auth.inactivity_timeout_minutes,
  });
  for (const transport of transports) {
    transport.controller.updateOptions(buildRemoteControllerOptions(config, deps));
    transport.speech?.setEnabled(config.voice?.output?.enabled === true);
  }
}
