import type { ToolApprovalMetadata } from './toolContract';
import {
  classifyShellCommand,
  type ShellClassification,
  type ShellSecretCheck,
} from './shellPolicy';
import type { ShellKind } from './shellCommandTokens';

const callClassifications = new WeakMap<Record<string, unknown>, ShellClassification>();

export function classifyShellCall(
  args: Record<string, unknown>,
  shell: ShellKind,
  check?: ShellSecretCheck,
): ShellClassification {
  const cached = callClassifications.get(args);
  if (cached) return cached;
  const classification = classifyShellCommand(String(args['command'] ?? ''), shell, check ?? {});
  callClassifications.set(args, classification);
  return classification;
}

export function clankerMayRunShellRefusal(
  classification: ShellClassification,
  clankerEnabled: boolean,
  attended: boolean,
): boolean {
  return (
    clankerEnabled &&
    attended &&
    classification.classification === 'refused' &&
    classification.rule?.gateKind === undefined
  );
}

export function clankerShellRefusalApproval(
  classification: ShellClassification,
  command: string,
  clankerEnabled: boolean,
  attended: boolean,
): ToolApprovalMetadata | undefined {
  if (!clankerMayRunShellRefusal(classification, clankerEnabled, attended)) return undefined;
  return { detail: `${command}\nClanker will run this non-owner, non-deny-list shell call.` };
}
