import { z } from 'zod';

/**
 * The two new top-level keys that come with the config split, plus the shape of
 * one engine. They live in their own file because `config/schema.ts` (the
 * config.yaml schema) and `config/policySchema.ts` (the policy.yaml schema)
 * both need them, and a cycle between those two would decide which one loads
 * first by accident.
 *
 * An engine is a named set of facts about how a server process is started and
 * stopped, plus which executable runs it. Those three things are code execution:
 * a model entry that could name its own `start_command` let an agent point Forge
 * at any program on this machine and Forge would run it on the next load. So the
 * engine lives in `~/.forge/policy.yaml` (owner-only), and a model in
 * `config.yaml` says only `engine: strata-8090`. A new model on an existing
 * engine is then a free edit; a new engine is an owner edit.
 */
export const EngineConfigSchema = z
  .object({
    /** argv only, never a shell command string, and never interpreted by Forge. */
    start_command: z
      .array(
        z
          .string()
          .refine((value) => value.trim().length > 0, 'start_command entries must not be empty'),
      )
      .min(1)
      .optional(),
    stop_command: z
      .array(
        z
          .string()
          .refine((value) => value.trim().length > 0, 'stop_command entries must not be empty'),
      )
      .min(1)
      .optional(),
    /** POSTed against a model's `endpoint` to free a server's memory. */
    unload_path: z
      .string()
      .regex(/^\/\S*$/, 'unload_path must be an absolute path such as /unload')
      .optional(),
    /** The llama.cpp-family executable this engine's models run. */
    llama_server_binary: z.string().min(1).optional(),
    /**
     * Which GPUs this engine's server occupies: CUDA device indexes as the
     * engine numbers them (the order `nvidia-smi` and `CUDA_VISIBLE_DEVICES`
     * use). It is a fact about HOW the process is started, so it lives here with
     * the start command and NOT on a `config.yaml` model — `modelSchema.ts` refuses
     * the key there. Absent = the engine says nothing, which overlaps EVERY other
     * engine: the behaviour every config has today. `BackendPoolExternal.prepareExternalForRequest`
     * unloads another managed server only when the two sets share an index, so
     * the owner can run a coder on the 3060 beside production on the 5060s
     * without either request unloading the other.
     */
    gpus: z
      .array(z.number().int().nonnegative())
      .min(1)
      .refine(
        (value) => new Set(value).size === value.length,
        'gpus must not repeat a device index',
      )
      .optional(),
  })
  .strict();

export const EnginesSchema = z.record(z.string().min(1), EngineConfigSchema).optional();

/** Hosts a `config.yaml` model `endpoint` may name besides loopback. A host list
 *  is an agent-reachable thing, so it belongs in the policy file with the
 *  permissions, not in the file an agent can edit. */
export const ModelHostsSchema = z.array(z.string().min(1)).optional();

export type EngineConfig = z.infer<typeof EngineConfigSchema>;

/**
 * The exec fields an engine owns, in the order the migration writes them.
 * `gpus` is deliberately NOT in this list even though it lives on the engine: these
 * four decide WHICH program Forge runs, and the migration moves only those. `gpus`
 * decides nothing about the program, so it is never migrated and never folded as an
 * exec field — a model entry carrying one is a plain schema error in `modelSchema.ts`.
 */
export const ENGINE_EXEC_FIELDS = [
  'start_command',
  'stop_command',
  'unload_path',
  'llama_server_binary',
] as const;

/** The engine a model's exec fields belong in: its last `group`/`groups` name,
 *  else `<model>-engine`. One rule, used both by the migration command and by
 *  the load-time warning, so the warning can name an engine the owner will
 *  actually find in policy.yaml. `groups` merge last-wins in ConfigResolver, so
 *  the last name is the one that would have supplied `endpoint` as well. */
export function engineNameForModel(model: {
  name: string;
  group?: string | undefined;
  groups?: string[] | undefined;
}): string {
  const names = model.groups?.length ? model.groups : model.group ? [model.group] : [];
  return names.length ? names[names.length - 1] : `${model.name}-engine`;
}
