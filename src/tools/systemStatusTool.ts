import type { RegisteredTool } from './ToolRegistry';
import { collectSystemReport, type SystemReportDeps } from '../system/SystemReport';
import { formatSystemReport } from '../system/formatSystemReport';

/**
 * The same machine report `/system` prints, as a tool.
 *
 * The agent can already reach these numbers by shelling out, but it takes
 * several rounds to get there and lands on `nvidia-smi --query-compute-apps`,
 * which reports `[N/A]` per process on WDDM. One call that answers correctly is
 * cheaper than three that answer wrongly — the `query_powershell list_processes`
 * precedent in CLAUDE.md.
 *
 * The result is the rendered table rather than JSON: it carries every field of
 * the struct in about a quarter of the tokens, and the tool exists to save
 * rounds.
 */
export function makeSystemStatusTool(deps: SystemReportDeps = {}): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'get_system_status',
        description:
          "Report this machine's GPUs (name, VRAM used/total, utilisation, temperature), which processes are holding VRAM (PID, name, size; Forge's own llama-server backends are tagged with their model), system RAM, and free space per fixed drive. Reads performance counters only -- it changes nothing. GPU indices are nvidia-smi ordering, which is NOT llama.cpp's CUDA device ordering.",
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
    },
    permission: 'headless',
    autoApprove: true,
    handler: async (_args, context) => {
      const report = await collectSystemReport(deps, context?.abortSignal);
      return formatSystemReport(report, { compact: true });
    },
  };
}
