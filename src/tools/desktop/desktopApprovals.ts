/**
 * Approval predicates for the desktop tool family (plan §4.2, §4.7, B2). Each
 * returns metadata when the call must be confirmed, undefined when it may run.
 */
import type { ForgeConfig } from '../../config/types';
import { resolveRequestModel } from '../../config/ConfigResolver';
import { usesLocalGpu } from '../../backend/ModelHeuristics';
import { isCloudProvider, getProviderDisplayName } from '../../llm/CloudProviders';
import type { ToolApprovalMetadata } from '../ToolRegistry';
import { isSystemChord, type PowerShellDesktopDriver } from './PowerShellDesktopDriver';
import { isVsCodeTarget } from './targetWindowGate';

type Approval = (args: Record<string, unknown>) => ToolApprovalMetadata | undefined;

type GetConfig = () => ForgeConfig;

/**
 * Cloud-model monitor-capture gate (§4.7). Returns an approval metadata if the
 * active model is a cloud provider (the screen would be sent to that provider);
 * undefined for local models, including an `openai-compatible` server on a
 * loopback endpoint (Strata): the provider type names the wire protocol, not
 * where the screen goes, and gating it made every capture a dangerous prompt
 * that clanker mode cannot skip. Window captures go through
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
    // Name the scope the user is approving: one display, not "the screen".
    // `monitor: 0` is the primary; the driver refuses an index past the last
    // display rather than widening to every monitor. Only a value the handler
    // can actually act on is named — for `0.5` or `-1` the prompt says "a
    // monitor" rather than promising a scope the call will be refused for.
    const requested = args.monitor;
    const named =
      typeof requested === 'number' && Number.isSafeInteger(requested) && requested >= 0;
    const scope = named
      ? `monitor ${String(requested)}${requested === 0 ? ' (the primary display)' : ''}`
      : 'a monitor';
    const config = getConfig();
    const modelId = config.active_model;
    if (!modelId) return undefined;
    try {
      const model = resolveRequestModel(config, modelId);
      if (isCloudProvider(model.provider) && !usesLocalGpu(model)) {
        const name = getProviderDisplayName(model);
        return {
          dangerous: true,
          detail: `A full ${scope} capture will be sent to ${name} (cloud model). Confirm to proceed.`,
        };
      }
    } catch (err) {
      // Fail closed: if the model cannot be resolved we cannot rule out a cloud
      // provider, so the user confirms instead of the screen leaving silently.
      return {
        dangerous: true,
        detail: `A full ${scope} capture; could not resolve the active model (${err instanceof Error ? err.message : String(err)}). Confirm to proceed.`,
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
 * Combine several approval predicates for one tool (plan Phase 3 item 4).
 *
 * A Code-target confirmation and a consequential / system-chord warning can
 * both apply to the same call. Composing them keeps the STRONGER warning — the
 * result is `dangerous` if any part is — and shows every reason, so confirming
 * a `ctrl+alt+delete` into a VS Code window names both the chord and the
 * window. Returning only the first match would let the Code prompt mask the
 * chord warning, or the reverse.
 */
export function composeApprovals(...approvals: readonly Approval[]): Approval {
  return (args) => {
    const fired = approvals
      .map((approve) => approve(args))
      .filter((meta): meta is ToolApprovalMetadata => meta !== undefined);
    if (fired.length === 0) return undefined;
    const details = fired
      .map((meta) => meta.detail)
      .filter((detail): detail is string => typeof detail === 'string' && detail !== '');
    return {
      ...(fired.some((meta) => meta.dangerous === true) ? { dangerous: true } : {}),
      ...(details.length > 0 ? { detail: details.join('\n') } : {}),
    };
  };
}

/**
 * Per-call confirmation for input aimed at a VS Code window (plan Phase 3 item
 * 4). The `allow_vscode` opt-in makes a Code window APPROVABLE; it must not make
 * it silently TYPEABLE — otherwise the opt-in alone would let a model drive
 * Forge's own chat input, one keystroke at a time, on the strength of a capture
 * taken minutes earlier.
 *
 * So every one of the six input tools asks again, per call, when its target is
 * Code — even the two that are `autoApprove: true` (`desktop_move_mouse`,
 * `desktop_scroll`) and `desktop_drag`, which no write-permission rule catches
 * because `desktop` is not a write permission. The binding approval from
 * `desktop_focus_window` / `desktop_capture` is NOT a substitute.
 *
 * The target is resolved the way the handler will resolve it: a coordinate tool
 * from its `capture_id`, type/press from the current approved target. The driver
 * is the only source — these predicates must not keep their own copy of gate
 * state, or the prompt and the gate can disagree about which window is meant.
 */
export function codeInputApproval(
  driver: Pick<PowerShellDesktopDriver, 'approvedTarget' | 'captureTarget'>,
  action: string,
): Approval {
  return (args) => {
    const captureId = typeof args.capture_id === 'string' ? args.capture_id : undefined;
    const target = captureId ? driver.captureTarget(captureId) : driver.approvedTarget();
    if (!target || !isVsCodeTarget(target)) return undefined;
    return {
      dangerous: true,
      detail:
        `${action} in the VS Code window "${target.title}" (HWND ${target.hwnd}) — this is the ` +
        'editor Forge itself runs in. Confirm this call: permissions.desktop.allow_vscode does ' +
        'not pre-approve input.',
    };
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
