/**
 * The `model_starter:` block (docs/plans/LAPTOP_MODEL_STARTER_PLAN.md,
 * "Config"). `shared_ports` and `port` are hand-mirrored from the Tailscale ACL
 * and the `tailscale serve` share, so the two mistakes that actually happen are
 * a starter pointed at the control server's port and a starter enabled without
 * the control server whose lifecycle state it borrows. Both are refused at load
 * time rather than discovered at the first laptop request.
 */
import { describe, it, expect } from 'vitest';
import { ForgeConfigSchema } from '../../src/config/schema';

const models = [
  { name: 'm', provider: 'llama.cpp', gguf_path: '/m.gguf' },
  { name: 's', provider: 'openai-compatible', endpoint: 'http://127.0.0.1:8090' },
];

function parse(controlServer: Record<string, unknown> | undefined, starter: unknown) {
  return ForgeConfigSchema.safeParse({
    models,
    active_model: 'm',
    // A llama.cpp model needs the binary, or every case below fails for that
    // reason instead than for the one under test.
    llama_server: { port: 8080, binary: 'llama-server' },
    ...(controlServer === undefined ? {} : { control_server: controlServer }),
    ...(starter === undefined ? {} : { model_starter: starter }),
  });
}

const issueText = (result: { error?: unknown }): string =>
  JSON.stringify((result as { error?: { issues?: unknown[] } }).error?.issues ?? []);

describe('model_starter config block', () => {
  it('is absent by default: no listener, no defaults applied', () => {
    const parsed = parse({ enabled: true, port: 8799 }, undefined);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.model_starter).toBeUndefined();
  });

  it('applies the documented defaults for port and lease TTL', () => {
    const parsed = parse({ enabled: true, port: 8799 }, {
      enabled: true,
      shared_ports: [8090],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.model_starter).toEqual({
      enabled: true,
      port: 8798,
      shared_ports: [8090],
      lease_ttl_s: 600,
    });
  });

  it('refuses a starter pointed at the control server port', () => {
    const same = parse({ enabled: true, port: 8798 }, {
      enabled: true,
      port: 8798,
      shared_ports: [8090],
    });
    expect(same.success).toBe(false);
    expect(issueText(same)).toContain('must differ from control_server.port');
    // With no control_server block, 8799 is the port the control server takes.
    const assumed = parse(undefined, { enabled: false, port: 8799, shared_ports: [8090] });
    expect(assumed.success).toBe(false);
    expect(issueText(assumed)).toContain('must differ from control_server.port');
  });

  it('requires control_server.enabled, because it borrows its state and chain', () => {
    const off = parse({ enabled: false, port: 8799 }, {
      enabled: true,
      shared_ports: [8090],
    });
    expect(off.success).toBe(false);
    expect(issueText(off)).toContain('requires control_server.enabled');
    const missing = parse(undefined, { enabled: true, shared_ports: [8090] });
    expect(missing.success).toBe(false);
    expect(issueText(missing)).toContain('requires control_server.enabled');
    // A disabled starter needs nothing: it binds nothing and borrows nothing.
    const idle = parse(undefined, { enabled: false, shared_ports: [8090] });
    expect(idle.success).toBe(true);
  });

  it('requires shared_ports, because an empty mirror refuses every model', () => {
    const empty = parse({ enabled: true, port: 8799 }, {
      enabled: true,
      shared_ports: [],
    });
    expect(empty.success).toBe(false);
    expect(issueText(empty)).toContain('too_small');
  });

  it('keeps the lease TTL inside the range that makes sense', () => {
    for (const ttl of [10, 30, 600, 86400, 86401]) {
      const parsed = parse({ enabled: true, port: 8799 }, {
        enabled: true,
        shared_ports: [8090],
        lease_ttl_s: ttl,
      });
      expect(parsed.success, `lease_ttl_s ${ttl}`).toBe(ttl >= 30 && ttl <= 86400);
    }
  });
});
