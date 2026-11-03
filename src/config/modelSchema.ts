import { z } from 'zod';
import * as net from 'net';
import {
  CacheTypeSchema,
  CapabilitiesSchema,
  GroupSchema,
  ProviderSchema,
  ReasoningEffortSchema,
  SamplingSchema,
  SpawnSchema,
  ToolCallLimitsSchema,
  ToolGroupsSchema,
} from './schemaShared';

/**
 * The model-side of the config schema: the active-model preprocessor, the
 * request-time role preset (F6), the per-model config, and the group-field
 * resolution the top-level refinement uses. Kept apart from schema.ts so the
 * model shape and the top-level assembly each have one home.
 */

export const ActiveModelSchema = z.preprocess(
  (value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'string' && value.trim().toLowerCase() === 'none') return null;
    return value;
  },
  z.union([z.string().min(1), z.null()]),
);

// Request-time role preset (F6).
export const ProfileSchema = z.object({
  system_prompt: z.string().optional(),
  // 'replace' sends system_prompt INSTEAD of the Forge template. Default
  // 'append' keeps the template and adds system_prompt beneath it.
  system_prompt_mode: z.enum(['append', 'replace']).optional(),
  sampling: SamplingSchema.optional(),
  think: z.boolean().optional(),
  reasoning_effort: ReasoningEffortSchema.optional(),
  strip_tools: z.boolean().optional(),
  strip_thinking_channels: z.boolean().optional(),
  capabilities: CapabilitiesSchema.optional(),
  max_tool_rounds: z.number().int().positive().optional(),
});

/**
 * `remote_start:` — a laptop entry whose model is served by ANOTHER machine's
 * Forge (docs/plans/LAPTOP_MODEL_STARTER_PLAN.md Phase 2). The laptop cannot
 * start a desktop server itself: `start_command` runs on the machine Forge runs
 * on, so it asks the desktop's model starter instead and uses the port that
 * answer reports — which is how a llama.cpp slot on an arbitrary 808x port
 * becomes reachable without guessing which quant loaded first.
 *
 * Every address must be an `http://` URL with an IP-literal host, not a name: a
 * name would be refused by Strata's DNS-rebinding rule and by the starter's own
 * Host check, so a `tailscale` DNS name would fail every request. `net.isIP`
 * accepts v4 and v6; the brackets URL parsing gives an IPv6 host are stripped
 * before the check.
 *
 * It may also be an ordered list of 1-4 addresses (docs/plans/
 * LAPTOP_LAN_ACCESS_PLAN.md): the laptop tries them in config order and uses the
 * one that answers, so a home laptop lists the LAN forwarder first and the
 * tailnet address second, and a laptop that moves networks changes route with no
 * one editing config.yaml. Config order is probe order every time — there is no
 * remembered preference that would keep a home laptop on the tailnet for no
 * reason.
 */
function isHttpIpLiteralUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:') return false;
    return net.isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0;
  } catch {
    return false;
  }
}

/**
 * `remote_start.starter` as written in YAML: one URL, or an ordered list of 1-4.
 * The checks are ordered so the address shape is reported before the count and
 * the duplicate — a list that is both too long and holds a name is the name's
 * fault first, and that is the one the user has to fix.
 */
const StarterListSchema = z
  .union([z.string(), z.array(z.string())])
  .refine(
    (value) => (Array.isArray(value) ? value.every(isHttpIpLiteralUrl) : isHttpIpLiteralUrl(value)),
    'remote_start.starter must be an http:// URL with an IP host',
  )
  .refine(
    (value) => !Array.isArray(value) || (value.length >= 1 && value.length <= 4),
    'remote_start.starter accepts one URL or a list of 1-4 URLs',
  )
  .refine(
    (value) => !Array.isArray(value) || new Set(value).size === value.length,
    'remote_start.starter must not repeat an address',
  );

/** The host part of a starter or endpoint URL, with the brackets URL parsing
 *  puts on an IPv6 literal stripped, so the two can be compared. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}

export const RemoteStartSchema = z
  .object({
    /** Where to reach the desktop's model starter: `http://100.64.0.10:8798`
     *  is the tailnet address `tailscale serve` forwards to the desktop's
     *  loopback; a home laptop puts `http://192.0.2.10:8798` — the desktop's
     *  LAN address, through the port forwarder — before it. One URL or a list of
     *  1-4, tried in this order (see `RemoteStarterRoute.ts`). */
    starter: StarterListSchema,
    /** The name the DESKTOP's config knows this model by. It is not this
     *  machine's name: the two configs name the same server differently. */
    model: z.string().min(1),
  })
  .strict();

/** `remote_start.starter` as the ordered list of addresses it always is: one URL
 *  is a one-element list, so no caller has to handle two shapes. A copy, so a
 *  caller can sort or filter it without touching the parsed config. */
export function starterUrls(remote: { starter: string | string[] }): string[] {
  return Array.isArray(remote.starter) ? [...remote.starter] : [remote.starter];
}

export const ModelConfigSchema = z.object({
  name: z.string().min(1),
  model: z.string().min(1).optional(),
  provider: ProviderSchema.optional(),
  token_count: z.enum(['tokenize', 'count_tokens', 'estimate']).optional(),
  cli: z.string().min(1).optional(),
  cli_model: z.string().min(1).optional(),
  gguf_path: z.string().min(1).optional(),
  mmproj_path: z.string().min(1).optional(),
  /** Named engine in `~/.forge/policy.yaml` that supplies this model's exec
   *  facts. The model's own fields still win, so an un-migrated config.yaml keeps
   *  working unchanged. Folded by `ConfigResolver.mergeGroupsIntoModel`; an
   *  unknown engine name is a load error naming the model and the engine. */
  engine: z.string().min(1).optional(),
  /**
   * Rejected, not stripped: which cards a server occupies is a fact about how it
   * is STARTED, and the start command lives on the engine, so `gpus` belongs under
   * `engines.<name>:` in `~/.forge/policy.yaml` (`engineSchema.ts`). Spelled out here
   * because this schema is not `.strict()`, so an unlisted key would otherwise be
   * dropped silently — and a dropped `gpus` reads as "overlaps every card", which
   * unloads a server that shares none. `z.never` rather than an `any`-based check:
   * the inferred entry type then carries `gpus?: never`, not `gpus?: any`.
   */
  gpus: z
    .never({
      error: 'gpus belongs on the engine in ~/.forge/policy.yaml, not on a model entry',
    })
    .optional(),
  // Per-model llama-server executable override (e.g. a patched fork for one
  // model). Absent = the global llama_server.binary. See ModelConfig.
  llama_server_binary: z.string().min(1).optional(),
  startup_timeout_ms: z.number().int().min(1_000).optional(),
  // Log file of a server Forge does not spawn (e.g. Strata), mirrored into an
  // output channel. See src/backend/serverLogFollower.ts.
  server_log: z.string().min(1).optional(),
  // POSTed against `endpoint` to free a local openai-compatible server's memory
  // (Strata). See src/backend/ExternalModelServers.ts.
  unload_path: z
    .string()
    .regex(/^\/\S*$/, 'unload_path must be an absolute path such as /unload')
    .optional(),
  // Opt-in process stop for a managed external server. argv only: never a
  // shell command string, and never interpreted by Forge.
  stop_on_exit: z.boolean().optional(),
  stop_command: z
    .array(
      z
        .string()
        .refine((value) => value.trim().length > 0, 'stop_command entries must not be empty'),
    )
    .min(1)
    .optional(),
  // Executable plus argv launched (detached) before a request when the managed
  // server is down. argv only: never a shell command string, never interpreted.
  start_command: z
    .array(
      z
        .string()
        .refine((value) => value.trim().length > 0, 'start_command entries must not be empty'),
    )
    .min(1)
    .optional(),
  // Omitted = disabled. No implicit default, and YAML `null` is rejected rather
  // than silently meaning "off" — opting in is explicit.
  image_retention_turns: z.number().int().nonnegative().optional(),
  endpoint: z.string().url().optional(),
  /** Laptop-side: ask another machine's model starter to start or load this
   *  model before each request and use the port it reports (see above). */
  remote_start: RemoteStartSchema.optional(),
  n_gpu_layers: z.number().int().optional(),
  num_ctx: z.number().int().positive().optional(),
  n_batch: z.number().int().positive().optional(),
  type_k: CacheTypeSchema.optional(),
  type_v: CacheTypeSchema.optional(),
  flash_attn: z.boolean().optional(),
  extra_llama_server_args: z.array(z.string()).optional(),
  n_parallel: z.number().int().positive().optional(),
  // v0.3 additions
  sampling: SamplingSchema.optional(),
  capabilities: CapabilitiesSchema.optional(),
  strip_tools: z.boolean().optional(),
  system_prompt: z.string().optional(),
  system_prompt_mode: z.enum(['append', 'replace']).optional(),
  think: z.boolean().optional(),
  chat_template_thinking: z.boolean().optional(),
  reasoning_effort: ReasoningEffortSchema.optional(),
  thinking_off_effort: ReasoningEffortSchema.optional(),
  strip_thinking_channels: z.boolean().optional(),
  api_key_secret: z.string().min(1).optional(),
  // F6 additions
  /** Request-time profiles exposed for this model; [] disables them. */
  profiles: z.array(z.string().min(1)).optional(),
  spawn: SpawnSchema.optional(),
  spawn_profiles: z.record(z.string(), SpawnSchema.partial()).optional(),
  // F7 additions (groups + fuzzy resolution + model manager identity fields)
  group: z.string().min(1).optional(),
  groups: z.array(z.string().min(1)).optional(),
  short_name: z.string().min(1).optional(),
  display_name: z.string().trim().min(1).max(60).optional(),
  category: z.string().min(1).optional(),
  comment: z.string().optional(),
  tools: z.array(z.string().min(1)).optional(),
  tool_call_limits: ToolCallLimitsSchema.optional(),
  max_output_tokens: z.number().int().positive().optional(),
  max_tool_rounds: z.number().int().positive().optional(),
  tool_groups: ToolGroupsSchema.optional(),
});

// Provider-requiredness checks (gguf_path/cli/endpoint/api_key_secret) live at
// the top-level ForgeConfigSchema refine (see below), not here — `provider`
// and `endpoint` are both fields a model may inherit from a referenced
// `group` (F7 §2.1), and a per-model refine has no visibility into `groups`.
// gguf_path/cli/api_key_secret are never group-suppliable (GroupSchema omits
// them), so they still resolve purely from the model itself.
type ModelConfigLike = z.infer<typeof ModelConfigSchema>;

/** What `effectiveGroupField` reads: the name, the group list, and the three
 *  fields a group may supply. Spelled as a `Pick` rather than the whole parsed
 *  entry because `gpus` is typed `never` in this schema (it belongs on the engine)
 *  and `ModelConfig` types it `number[] | undefined` — those two are disjoint, so
 *  a hand-written entry could not be passed at all, even though every field this
 *  function touches matches exactly. */
type GroupFieldSource = Pick<
  ModelConfigLike,
  'name' | 'group' | 'groups' | 'provider' | 'endpoint' | 'token_count'
>;

/** Last group in the model's `group`/`groups` list that defines `field`
 *  wins — matches ConfigResolver.mergeGroupsIntoModel's merge order. */
export function effectiveGroupField<K extends 'provider' | 'endpoint' | 'token_count'>(
  model: GroupFieldSource,
  groups: Record<string, z.infer<typeof GroupSchema>> | undefined,
  field: K,
): ModelConfigLike[K] | undefined {
  const names = model.groups ?? (model.group ? [model.group] : []);
  let value: ModelConfigLike[K] | undefined;
  for (const name of names) {
    const group = groups?.[name];
    const fieldValue = group?.[field];
    if (fieldValue !== undefined) value = fieldValue as ModelConfigLike[K];
  }
  return value;
}

/** Fields that would make THIS window the owner of a server it cannot own. */
const REMOTE_START_FORBIDDEN_FIELDS = [
  'unload_path',
  'start_command',
  'stop_command',
  'stop_on_exit',
] as const;

/** What `validateRemoteStartEntry` reads. Every field is optional and
 *  explicitly `| undefined` so a caller can pass a parsed config entry under
 *  `exactOptionalPropertyTypes`. `starter` is one URL or the list of them, as
 *  the schema leaves it. */
export interface RemoteStartEntryShape {
  remote_start?: { starter: string | string[]; model: string } | undefined;
  unload_path?: string | undefined;
  start_command?: string[] | undefined;
  stop_command?: string[] | undefined;
  stop_on_exit?: boolean | undefined;
}

/**
 * Refusals for a `remote_start` entry — a laptop's view of ANOTHER machine's
 * server. Everything that would make this window manage it has to be absent:
 * with `unload_path` present the entry becomes a managed external here, so
 * `freeVramForExternal` tries to unload the other desktop entries before every
 * request — and through `tailscale serve` a stopped server RESETS the
 * connection instead of refusing it, so that unload throws and the request
 * never goes out (found 2026-10-26, LAPTOP_MODEL_STARTER_PLAN problem 4). The
 * desktop's starter starts, unloads and stops these servers; the laptop only
 * asks, and `isManagedExternalModel` stays false for them because there is no
 * `unload_path` to make them managed.
 *
 * `provider` and `endpoint` are passed in rather than read from the entry
 * because either may be inherited from a referenced group, which only the
 * top-level refine can see.
 */
export function validateRemoteStartEntry(
  model: RemoteStartEntryShape,
  provider: string | undefined,
  endpoint: string | undefined,
  path: [string, number],
  ctx: z.RefinementCtx,
): void {
  if (!model.remote_start) return;
  if (provider !== 'openai-compatible') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...path, 'remote_start'],
      message: `remote_start is only for provider: openai-compatible (got ${provider ?? 'no provider'})`,
    });
  }
  for (const managedField of REMOTE_START_FORBIDDEN_FIELDS) {
    if (model[managedField] !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, managedField],
        message:
          `remote_start forbids ${managedField}: the desktop's own starter starts, ` +
          'unloads and stops this model',
      });
    }
  }
  // The base URL is rebuilt on the host of the starter that ANSWERED, so an
  // endpoint pointing at another host is a route this client cannot take: the
  // two addresses have to name the same machine. Checked here so a typo in
  // either fails at config load, not on the first request.
  const endpointHost = endpoint === undefined ? '' : hostOf(endpoint);
  if (endpointHost) {
    const hosts = new Set(starterUrls(model.remote_start).map(hostOf));
    if (!hosts.has(endpointHost)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, 'endpoint'],
        message:
          `endpoint host ${endpointHost} is not one of the remote_start.starter hosts ` +
          `(${[...hosts].join(', ')}): the laptop dials the address that answered, so ` +
          'endpoint and starter must name the same machine',
      });
    }
  }
}
