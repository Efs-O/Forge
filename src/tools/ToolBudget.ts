import type { ModelConfig } from '../config/types';
import type { ToolDefinition } from '../llm/types';

/**
 * Per-turn tool allowlist + call-budget enforcement for a resolved model
 * (post group-merge — see `ConfigResolver.mergeGroupsIntoModel`). Construct
 * one instance per turn (AgentLoop) or per worker run (WorkerLoop); state is
 * never shared across turns/runs. This narrows what
 * ToolRegistry/PermissionResolver already allow — it never grants back
 * something permissions deny, since permission checks always still run in
 * `ToolRegistry.dispatch`. See CONFIG_OVERHAUL_PLAN.md §2.1/§4 step 3.
 */
export class ToolBudget {
  private readonly allowlist: ReadonlySet<string> | null;
  private readonly limits: ReadonlyMap<string, number>;
  private readonly used = new Map<string, number>();

  constructor(model: Pick<ModelConfig, 'tools' | 'tool_call_limits'>) {
    this.allowlist = model.tools && model.tools.length > 0 ? new Set(model.tools) : null;
    this.limits = new Map(Object.entries(model.tool_call_limits ?? {}));
  }

  /** True when `name` must never be advertised: outside the allowlist (when
   *  one is set), or budgeted to zero calls this turn. */
  private isExcluded(name: string): boolean {
    if (this.allowlist && !this.allowlist.has(name)) return true;
    return this.limits.get(name) === 0;
  }

  /** Drop excluded tool definitions from an already permission-filtered list. */
  filterDefinitions(definitions: readonly ToolDefinition[]): ToolDefinition[] {
    return definitions.filter((d) => !this.isExcluded(d.function.name));
  }

  /**
   * Call immediately before dispatching a tool named `name`. Never throws —
   * returns a structured tool-result string when the call must be refused
   * (not allowlisted, or its per-turn budget is exhausted), or `null` when
   * the call may proceed (which also consumes one unit of budget for
   * tools carrying a `tool_call_limits` entry).
   */
  check(name: string): string | null {
    if (this.allowlist && !this.allowlist.has(name)) {
      return `Tool ${name} is not available for this model.`;
    }
    const limit = this.limits.get(name);
    if (limit === undefined) return null;
    const usedSoFar = this.used.get(name) ?? 0;
    if (usedSoFar >= limit) {
      return (
        `Budget exhausted: ${name} was limited to ${limit} calls this turn ` +
        `(${usedSoFar} used). Do not call it again; wrap up with what you have.`
      );
    }
    this.used.set(name, usedSoFar + 1);
    return null;
  }
}
