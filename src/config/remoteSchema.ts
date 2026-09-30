import { z } from 'zod';

/**
 * The remote-side of the config schema: the owner-contact web settings and the
 * whole `remote` block (queue, auth, attachments, workspace aliases, wake
 * relay, channels). Kept apart from schema.ts so the remote shape has one home.
 */

export const RemoteContactsConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    web: z
      .object({
        enabled: z.boolean().default(false),
        max_results: z.number().int().min(1).max(5).default(5),
        max_fetch_bytes: z.number().int().min(10_000).max(200_000).default(200_000),
        timeout_ms: z.number().int().min(1_000).max(30_000).default(15_000),
      })
      .default({
        enabled: false,
        max_results: 5,
        max_fetch_bytes: 200_000,
        timeout_ms: 15_000,
      }),
  })
  .default({
    enabled: false,
    web: {
      enabled: false,
      max_results: 5,
      max_fetch_bytes: 200_000,
      timeout_ms: 15_000,
    },
  });

export const RemoteConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    queue_limit: z.number().int().min(1).max(100).default(5),
    max_message_chars: z.number().int().min(1).max(50_000).default(12_000),
    rate_limit_per_minute: z.number().int().min(1).max(600).default(30),
    /** Seconds to keep a recognized /command before deleting it from Telegram; 0 disables. */
    delete_command_messages_after: z.number().int().min(0).max(3600).default(5),
    /** Seconds to keep command replies and ephemeral host notifications; 0 disables. */
    delete_command_replies_after: z.number().int().min(0).max(3600).default(10),
    auth: z
      .object({
        inactivity_timeout_minutes: z.number().int().min(0).max(1_440).default(30),
      })
      .default({ inactivity_timeout_minutes: 30 }),
    attachments: z
      .object({
        enabled: z.boolean().default(false),
        retain_days: z.union([z.number().int().min(1).max(365), z.null()]).default(30),
        accept_pdf: z.boolean().default(true),
      })
      .default({ enabled: false, retain_days: 30, accept_pdf: true }),
    contacts: RemoteContactsConfigSchema,
    workspace_aliases: z
      .record(
        z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
        z.object({ path: z.string().min(1), display_name: z.string().min(1).max(80) }),
      )
      .default({}),
    wake_relay: z
      .object({
        enabled: z.boolean().default(false),
        host: z.string().regex(/^(?:\d{1,3}\.){3}\d{1,3}$/, 'host must be an IPv4 address'),
        port: z.number().int().min(1024).max(65535),
        relay_ip: z.string().regex(/^(?:\d{1,3}\.){3}\d{1,3}$/, 'relay_ip must be an IPv4 address'),
      })
      .optional(),
    telegram: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
    whatsapp: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
  })
  .optional();
