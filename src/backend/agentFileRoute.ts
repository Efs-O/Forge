import { z } from 'zod';
import { codePointLength } from '../util/codePoints';
import type { RemoteFileSendResult } from '../remote/types';

const AgentFileRequestSchema = z
  .object({
    from: z.string().trim().min(1).max(40),
    conversation_id: z.string().trim().min(1).max(128),
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => value.trim().length > 0),
    caption: z
      .string()
      .refine((value) => codePointLength(value) <= 1024, 'must be at most 1024 characters')
      .optional(),
  })
  .strict();

export interface AgentFileRouteDeps {
  validateFrom: (
    from: string,
  ) =>
    | { ok: true }
    | { ok: false; error: string }
    | Promise<{ ok: true } | { ok: false; error: string }>;
  sendFile: (
    from: string,
    conversationId: string,
    workspaceRelativePath: string,
    caption: string,
  ) => Promise<RemoteFileSendResult>;
}

export async function handleAgentFileRoute(
  fields: Readonly<Record<string, unknown>>,
  deps: AgentFileRouteDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const parsed = AgentFileRequestSchema.safeParse(fields);
  if (!parsed.success) {
    const error = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`)
      .join('; ');
    return { status: 400, body: { error } };
  }
  const request = parsed.data;
  const sender = await deps.validateFrom(request.from);
  if (!sender.ok) return { status: 400, body: { error: sender.error } };

  let result: RemoteFileSendResult;
  try {
    result = await deps.sendFile(
      request.from,
      request.conversation_id,
      request.path,
      request.caption ?? '',
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    result = {
      kind: 'unknown',
      error: `The file send outcome could not be confirmed: ${detail}. No automatic retry was attempted.`,
    };
  }

  if (result.kind === 'sent') return { status: 200, body: { sent: true } };
  if (result.kind === 'refused')
    return { status: 409, body: { kind: result.kind, error: result.error } };
  return { status: 502, body: { kind: result.kind, error: result.error } };
}
