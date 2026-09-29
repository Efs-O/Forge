/**
 * Approval predicates for the desktop tool family (plan §4.2, §4.7, B2). Each
 * returns metadata when the call must be confirmed, undefined when it may run.
 */
import type { ForgeConfig } from '../../config/types';
import { resolveRequestModel } from '../../config/ConfigResolver';
import { isCloudProvider, getProviderDisplayName } from '../../llm/CloudProviders';
import type { ToolApprovalMetadata } from '../ToolRegistry';
import { isSystemChord, type PowerShellDesktopDriver } from './PowerShellDesktopDriver';

type Approval = (args: Record<string, unknown>) => ToolApprovalMetadata | undefined;

type GetConfig = () => ForgeConfig;

/**
 * Cloud-model monitor-capture gate (§4.7). Returns an approval metadata if the
 * active model is a cloud provider (the screen would be sent to that provider);
 * undefined for local models. Window captures go through
 * `windowCaptureApproval` instead.
 */
export function cloudMonitorApproval(
  getConfig: GetConfig,
): (args: Record<string, unknown>) => ToolApprovalMetadata | undefined {
  return (args) => {
    // Mirror the handler's kind resolution: `{monitor: 0}` with no kind is a monitor capture.
    const isMonitor =
      args.kind === 'monitor' ||
      (args.kind === undefined && !args.window_title && typeof args.monitor === 'number');
    if (!isMonitor) return undefined;
    const config = getConfig();
    const modelId = config.active_model;
    if (!modelId) return undefined;
    try {
      const model = resolveRequestModel(config, modelId);
      if (isCloudProvider(model.provider)) {
        const name = getProviderDisplayName(model);
        return {
          dangerous: true,
          detail: `Full-screen capture will be sent to ${name} (cloud model). Confirm to proceed.`,
        };
      }
    } catch (err) {
      // Fail closed: if the model cannot be resolved we cannot rule out a cloud
      // provider, so the user confirms instead of the screen leaving silently.
      return {
        dangerous: true,
        detail: `Full-screen capture; could not resolve the active model (${err instanceof Error ? err.message : String(err)}). Confirm to proceed.`,
      };
    }
    return undefined;
  };
}

/**
 * System-chord approval for `desktop_press` (B2). Returns a dangerous approval
 * for any system chord (`win+*`, `alt+f4`, `ctrl+alt+*`); undefined otherwise.
 * The driver does NOT refuse these — an explicitly approved system chord on the
 * approved target window is allowed.
 */
export function systemChordApproval(): (
  args: Record<string, unknown>,
) => ToolApprovalMetadata | undefined {
  return (args) => {
    const keys = Array.isArray(args.keys) ? (args.keys as string[]) : [];
    if (isSystemChord(keys)) {
      return {
        dangerous: true,
        detail: `System chord [${keys.join('+')}] — confirm before pressing`,
      };
    }
    return undefined;
  };
}

/** Consequential hint for input tools. */
export function consequentialApproval(
  toolName: string,
): (args: Record<string, unknown>) => ToolApprovalMetadata | undefined {
  return (args) => {
    if (args.consequential === true) {
      return { dangerous: true, detail: `Consequential ${toolName} — confirm before proceeding` };
    }
    return undefined;
  };
}

/**
 * `desktop_capture` approval. A window capture binds the control target, so a
 * NEW window needs the user's approval (plan §4.2); re-capturing the window
 * that is already approved does not. Monitor captures use the cloud gate.
 */
export function captureApproval(
  driver: Pick<PowerShellDesktopDriver, 'coversTitle'>,
  monitorApproval: Approval,
): Approval {
  return (args) => {
    const title = typeof args.window_title === 'string' ? args.window_title : '';
    if (title === '' || args.kind === 'monitor') return monitorApproval(args);
    if (driver.coversTitle(title)) return undefined;
    return { detail: `Approve capturing and controlling "${title}" (binds HWND+pid)` };
  };
}
