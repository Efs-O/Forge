import type { ForgeConfig } from '../config/types';
import { resolveRequestModel } from '../config/ConfigResolver';
import { classifyModelRoute, isCloudModelRoute } from '../llm/ModelRouteClassifier';
import type { RegisteredTool } from './ToolRegistry';
import {
  MAX_CONTEXT_HINTS,
  MAX_REVIEW_TASK_CHARS,
  MAX_WORKERS,
  MAX_WORKER_OUTPUT_TOKENS,
  MAX_WORKER_TASK_CHARS,
  MAX_WRITABLE_PATHS,
} from '../workers/limits';
import type { WorkerRunRequest } from '../workers/types';
import { resolveToolPermissions } from './PermissionResolver';

interface WorkerModelCatalogEntry {
  name: string;
  route: ReturnType<typeof classifyModelRoute>;
  cloud: boolean;
  profiles: string[];
  aliases: string[];
  short_name?: string;
  category?: string;
}

function hasWriteWorker(args: Record<string, unknown>): boolean {
  const workers = args['workers'];
  return (
    Array.isArray(workers) &&
    workers.some(
      (worker) =>
        typeof worker === 'object' &&
        worker !== null &&
        (worker as Record<string, unknown>)['access'] === 'write',
    )
  );
}

function assertCliWorkersAreReadOnly(config: ForgeConfig, request: WorkerRunRequest): void {
  for (const worker of request.workers ?? []) {
    if (worker.access !== 'write') continue;
    const model = resolveRequestModel(config, worker.model);
    if (model.provider === 'cli') {
      throw new Error(
        `dispatch_workers: CLI worker "${model.name}" cannot receive write access yet. ` +
          'Its one-shot transport has no command-approval channel; use a read task or let the coordinator apply the verified changes.',
      );
    }
  }
}

export function makeListWorkerModelsTool(getConfig: () => ForgeConfig): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'list_worker_models',
        description:
          'List configured Forge model names eligible for worker dispatch, with short_name/alias/category hints. Call this before dispatch_workers when the user did not provide an exact configured model name (dispatch_workers also accepts short_name and unambiguous partial names directly).',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
    },
    permission: 'delegate',
    advertise: () => getConfig().models.length > 0,
    handler: async () => {
      const config = getConfig();
      const includeCloud = resolveToolPermissions(config).has('cloud-worker');
      const profiles = Object.keys(config.profiles ?? {});
      const entries: WorkerModelCatalogEntry[] = config.models.flatMap((model) => {
        const route = classifyModelRoute(model);
        const cloud = isCloudModelRoute(route);
        if (cloud && !includeCloud) return [];
        const aliases = Object.entries(config.aliases ?? {})
          .filter(([, target]) => target.split('@', 1)[0] === model.name)
          .map(([alias]) => alias);
        return [
          {
            name: model.name,
            route,
            cloud,
            profiles,
            aliases,
            ...(model.short_name ? { short_name: model.short_name } : {}),
            ...(model.category ? { category: model.category } : {}),
          },
        ];
      });
      return JSON.stringify(entries);
    },
  };
}

export function makeDispatchWorkersTool(getConfig: () => ForgeConfig): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'dispatch_workers',
        description:
          'Dispatch one or two configured Forge models as coding workers. Use list_worker_models first unless the user supplied an exact configured model name. Set access to read for review/research with no allowed_paths. Set access to write only for Forge-native workers when changes are required and assign exact allowed_paths. CLI workers are read-only until their transport supports Forge command policy enforcement. Never claim a worker ran unless this tool returns a run result. Example: {"workers":[{"id":"worker-a","model":"gemma@worker","task":"Implement the parser","access":"write","context_files":["docs/parser.md"],"allowed_paths":["src/parser.ts"],"max_output_tokens":1024}],"review_task":"Review the worker change."}',
        parameters: {
          type: 'object',
          properties: {
            workers: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_WORKERS,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,40}$' },
                  model: { type: 'string', minLength: 1 },
                  task: { type: 'string', minLength: 1, maxLength: MAX_WORKER_TASK_CHARS },
                  access: { type: 'string', enum: ['read', 'write'] },
                  context_files: {
                    type: 'array',
                    maxItems: MAX_CONTEXT_HINTS,
                    uniqueItems: true,
                    items: { type: 'string' },
                  },
                  allowed_paths: {
                    type: 'array',
                    minItems: 1,
                    maxItems: MAX_WRITABLE_PATHS,
                    uniqueItems: true,
                    items: { type: 'string' },
                  },
                  max_output_tokens: {
                    type: 'integer',
                    minimum: 1,
                    maximum: MAX_WORKER_OUTPUT_TOKENS,
                  },
                },
                required: ['id', 'model', 'task', 'access'],
                additionalProperties: false,
              },
            },
            review_task: { type: 'string', maxLength: MAX_REVIEW_TASK_CHARS },
          },
          required: ['workers'],
          additionalProperties: false,
        },
      },
    },
    permission: 'delegate',
    additionalPermissions: ['read'],
    additionalPermissionsForArgs: (args) => (hasWriteWorker(args) ? ['write'] : []),
    advertise: () => getConfig().models.length > 0,
    approval: (args) => {
      const request = args as unknown as WorkerRunRequest;
      const config = getConfig();
      const cliNames = (request.workers ?? []).flatMap((worker) => {
        try {
          const resolved = resolveRequestModel(config, worker.model);
          return resolved.provider === 'cli' ? [resolved.cli ?? resolved.name] : [];
        } catch {
          return [];
        }
      });
      if (cliNames.length > 0) {
        return {
          dangerous: true,
          detail: `External CLI agent (${cliNames.join(', ')}) will run with its own tools in this workspace`,
        };
      }
      const cloud = request.workers?.filter((worker) => {
        try {
          return isCloudModelRoute(classifyModelRoute(resolveRequestModel(config, worker.model)));
        } catch {
          return false;
        }
      });
      if (!cloud?.length) return {};
      return {
        dangerous: true,
        detail:
          `Cloud worker launch: ${cloud.map((worker) => worker.model).join(', ')}. ` +
          'Tasks and workspace file contents read by these workers may leave this machine.',
      };
    },
    handler: async (args, context) => {
      if (!context?.runWorkers) throw new Error('dispatch_workers: no active Forge worker turn');
      const request = args as unknown as WorkerRunRequest;
      assertCliWorkersAreReadOnly(getConfig(), request);
      return JSON.stringify(await context.runWorkers(request));
    },
  };
}
