import type { ToolApprovalMetadata } from './toolContract';
import {
  classifyShellCommand,
  type ShellClassification,
  type ShellSecretCheck,
} from './shellPolicy';
import type { ShellKind } from './shellCommandTokens';
import type { ShellTokenRule } from './DenyList';

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

/**
 * What the rule a shell command matched tells the approval queue.
 *
 * `shellTool.ts` sits at this repo's 500-line gate, so the shape is assembled
 * here, next to the classifier that produced the rule. Three facts travel:
 * which kind of gate the rule is, the deny list's own name for the rule
 * (`denyRule` — the card's `cardReason` is prose *around* that name, so a
 * decision that read the card back would break the day the card is reworded),
 * and whether that rule says a Clanker chat answers the stop itself
 * (`clankerRedirect`), which is decided where the rule is written.
 */
export function matchedRuleGate(
  rule: ShellTokenRule | undefined,
): Pick<ToolApprovalMetadata, 'gateKind' | 'denyRule' | 'clankerRedirect'> {
  if (!rule) return {};
  return {
    ...(rule.gateKind ? { gateKind: rule.gateKind } : {}),
    ...(rule.gateKind === 'denyList' ? { denyRule: rule.description } : {}),
    ...(rule.clankerRedirect ? { clankerRedirect: true } : {}),
  };
}
