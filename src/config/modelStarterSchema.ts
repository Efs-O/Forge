import { z } from 'zod';

/**
 * `model_starter:` — the desktop-side listener a laptop Forge calls to START a
 * desktop model it cannot start itself (docs/plans/LAPTOP_MODEL_STARTER_PLAN.md).
 * Absent means no listener at all: no port bound, no lease bookkeeping, and the
 * desktop config keeps the KV prefix it had without the block.
 *
 * `port` and `shared_ports` are hand-mirrored from the Tailscale side: `port`
 * must equal the `tailscale serve --tcp <port>` share, and `shared_ports` must
 * equal the ACL's dst ports for the laptop. The mirror is what lets the
 * starter refuse an unreachable model with a reason instead of letting the
 * laptop time out on it. The two cross-block checks (port vs control_server,
 * enabled vs control_server.enabled) run in schema.ts's superRefine, because
 * only the top-level schema sees both blocks.
 */
export const ModelStarterConfigSchema = z
  .object({
    /** Off unless explicitly enabled: an absent block, or `enabled: false`, means
     *  nothing is listening and no laptop can start anything. */
    enabled: z.boolean().default(false),
    /** Loopback port the starter binds. Must match `tailscale serve --tcp <port>`,
     *  because the tailnet forwards that port to 127.0.0.1:<port>. */
    port: z.number().int().min(1).max(65535).default(8798),
    /**
     * Which model ports the tailnet actually lets the laptop reach. Mirrors the
     * Tailscale ACL by hand, so `/models` and `/ensure` can answer
     * `port_not_shared` instead of sending the laptop to a port that times out.
     * llama.cpp entries must list every slot port the pool can hand out
     * (`llama_server.port` .. `+ max_simultaneous_models - 1`).
     */
    shared_ports: z.array(z.number().int().min(1).max(65535)).min(1),
    /**
     * How long a remote lease lives after the last `POST /ensure` from that
     * client. The laptop renews every third of it while its turn runs, so this
     * is the window in which a desktop exit or eviction leaves the laptop's
     * model alone; it is also how long a crashed laptop's model stays loaded.
     * Long enough for a laptop window reload (~2 min) to re-ensure, short
     * enough that an abandoned model is freed without an owner doing anything.
     */
    lease_ttl_s: z.number().int().min(30).max(86400).default(600),
  })
  .optional();

export type ModelStarterConfig = NonNullable<z.infer<typeof ModelStarterConfigSchema>>;

/** Top-level port and shared-lifecycle checks for the starter block. */
export function validateModelStarterConfig(
  starter: ModelStarterConfig | undefined,
  controlServer: { enabled?: boolean | undefined; port?: number | undefined } | undefined,
  defaultControlPort: number,
  ctx: z.RefinementCtx,
): void {
  if (!starter) return;
  const controlPort = controlServer?.port ?? defaultControlPort;
  if (starter.port === controlPort) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['model_starter', 'port'],
      message: `model_starter.port must differ from control_server.port (both ${controlPort})`,
    });
  }
  if (starter.enabled && controlServer?.enabled !== true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['model_starter', 'enabled'],
      message:
        'model_starter.enabled requires control_server.enabled: true (the starter shares its ' +
        'lifecycle state and serialization chain)',
    });
  }
}
