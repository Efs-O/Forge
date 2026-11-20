/**
 * The `remote_start:` field (docs/plans/LAPTOP_MODEL_STARTER_PLAN.md Phase 2,
 * "Config" / "Refinements"). A laptop entry names ANOTHER machine's server, and
 * the two mistakes that actually happen are an entry that also carries the
 * desktop's management fields and a `starter` written as a name:
 *
 * - `unload_path` makes this window treat the entry as a managed external, so
 *   `freeVramForExternal` tries to unload the OTHER desktop entries before every
 *   request. Through `tailscale serve` a stopped listener resets the connection
 *   instead of refusing it, so that unload throws and the request never goes out
 *   (the plan's problem 4, found 2026-10-26).
 * - A name instead of an IP is refused by the listener on the other end (the
 *   starter's own Host check, and Strata's DNS-rebinding rule), so a
 *   `tailscale` DNS name would fail every single request.
 *
 * Both are refused at load time so the laptop never sends a request that cannot
 * work. The field itself and these refusals live in `modelSchema.ts`.
 *
 * Phase 1 of `docs/plans/LAPTOP_LAN_ACCESS_PLAN.md` added the list form: one URL
 * or 1-4 of them, tried in config order, so a home laptop lists the LAN
 * forwarder first and the tailnet address second. What has to stay true for
 * every address is the IP-literal rule (a name is refused by the listener on the
 * other end), and `endpoint` has to name one of the same hosts: the base URL is
 * rebuilt on whichever address answered, so an endpoint on another machine is a
 * route this client cannot take.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { ForgeConfigSchema } from '../../src/config/schema';

/** A laptop's entry for a desktop server: the endpoint's port is a guess that
 *  `POST /ensure` replaces, and `remote_start` names the desktop's starter and
 *  the name THE DESKTOP uses for that model. */
const laptopEntry = (extra: Record<string, unknown>) => ({
  name: 'strata-laptop',
  provider: 'openai-compatible',
  endpoint: 'http://100.64.0.10:8090',
  model: 'qwen',
  remote_start: { starter: 'http://100.64.0.10:8798', model: 'strata-flashnext-iq3s' },
  ...extra,
});

function parse(entry: Record<string, unknown>) {
  return ForgeConfigSchema.safeParse({
    active_model: 'strata-laptop',
    models: [laptopEntry(entry)],
  });
}

const issueText = (result: { error?: unknown }): string =>
  JSON.stringify((result as { error?: { issues?: unknown[] } }).error?.issues ?? []);

/** The host part of a starter or endpoint URL, brackets on an IPv6 literal
 *  stripped, so two of them can be compared. */
function urlHost(value: string): string {
  try {
    return new URL(value).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}

/** `remote_start.starter` as the ordered list it always is on the way in. */
function starterList(starter: string | string[] | undefined): string[] {
  return Array.isArray(starter) ? starter : starter ? [starter] : [];
}

/**
 * Which end of a starter list a fixture entry is meant to be: a private-LAN
 * address (RFC 1918 — 10/8, 172.16/12, 192.168/16) or a Tailscale one
 * (100.64.0.0/10, RFC 6598 shared address space). The owner's real addresses
 * live in `docs/plans/LAPTOP_FORGE_CONFIG.yaml`, which is local-only, so this
 * file checks the ORDER and the KIND of each address, never its exact value.
 */
function isPrivateLan(host: string): boolean {
  return (
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

function isTailscaleRange(host: string): boolean {
  return /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host);
}

describe('remote_start entries (the laptop half)', () => {
  it('parses a complete entry, and a laptop config needs no llama_server.binary', () => {
    const parsed = parse({});
    expect(parsed.success, issueText(parsed)).toBe(true);
    expect(parsed.success && parsed.data.models[0]?.remote_start?.model).toBe(
      'strata-flashnext-iq3s',
    );
    // The whole point of the laptop config: every model here is someone else's
    // server, so nothing on this machine has to be loaded by a local llama.cpp.
    expect(parsed.success && parsed.data.llama_server.binary).toBeUndefined();
  });

  it('forbids unload_path, the field that would make this window manage it', () => {
    const parsed = parse({ unload_path: '/unload' });
    expect(parsed.success).toBe(false);
    expect(issueText(parsed)).toContain('remote_start forbids unload_path');
  });

  it('forbids the other three fields that describe a server this machine owns', () => {
    for (const extra of [
      { start_command: ['start-strata.bat'] },
      { stop_command: ['stop-strata.bat'] },
      { stop_on_exit: true },
    ]) {
      const parsed = parse(extra);
      expect(parsed.success, JSON.stringify(extra)).toBe(false);
      expect(issueText(parsed)).toContain(`remote_start forbids ${Object.keys(extra)[0]}`);
    }
  });

  it('is refused on any provider that is not openai-compatible', () => {
    for (const provider of ['llama.cpp', 'ollama', 'openrouter']) {
      const parsed = parse({ provider, gguf_path: '/m.gguf', api_key_secret: 'k' });
      expect(parsed.success, provider).toBe(false);
      expect(issueText(parsed)).toContain(
        `remote_start is only for provider: openai-compatible (got ${provider})`,
      );
    }
  });

  it('requires an http URL with an IP host, because a name is refused at the other end', () => {
    // An IPv6 starter needs an IPv6 endpoint too: the two have to name the same
    // machine, which is the point of the host check below.
    const pairs = [
      ['http://100.64.0.10:8798', 'http://100.64.0.10:8090'],
      ['http://[fd00::1234:5678]:8798', 'http://[fd00::1234:5678]:8090'],
    ];
    for (const [starter, endpoint] of pairs) {
      const parsed = parse({ endpoint, remote_start: { starter, model: 'strata' } });
      expect(parsed.success, `${starter}: ${issueText(parsed)}`).toBe(true);
    }
    for (const starter of [
      'https://100.64.0.10:8798', // `tailscale serve` forwards plain HTTP
      'http://desktop-1.tailnet-xyz.ts:8798', // a name: refused by the Host check
      'http://localhost:8798', // resolves to a name, not an IP literal
      '100.64.0.10:8798', // no scheme: not a URL
      '',
    ]) {
      const parsed = parse({ remote_start: { starter, model: 'strata' } });
      expect(parsed.success, starter).toBe(false);
      expect(issueText(parsed)).toContain('must be an http:// URL with an IP host');
    }
  });

  /** The list form, and the three shapes that are not addresses but are still
   *  mistakes a laptop can make while writing one. */
  it('accepts a list of addresses in config order', () => {
    const starter = ['http://192.0.2.10:8798', 'http://100.64.0.10:8798'];
    // `endpoint` may name EITHER host: at home the laptop dials .70 and away it
    // dials .107, and the schema cannot know which, so it only requires that the
    // two address the same machine.
    for (const endpoint of ['http://192.0.2.10:8090', 'http://100.64.0.10:8090']) {
      const parsed = parse({ endpoint, remote_start: { starter, model: 'strata' } });
      expect(parsed.success, `${endpoint}: ${issueText(parsed)}`).toBe(true);
    }
    const parsed = parse({ remote_start: { starter, model: 'strata' } });
    // The list is kept as written, because config order IS probe order.
    expect(parsed.success && parsed.data.models[0]?.remote_start?.starter).toEqual(starter);
  });

  it('refuses an empty list, more than four addresses, and a repeated one', () => {
    const four = [
      'http://192.0.2.10:8798',
      'http://100.64.0.10:8798',
      'http://192.0.2.11:8798',
      'http://100.64.0.11:8798',
    ];
    const cases: Array<[string, string[]]> = [
      ['an empty list', []],
      ['five addresses', [...four, 'http://192.0.2.12:8798']],
      ['a repeated address', [four[0]!, four[0]!]],
    ];
    for (const [label, list] of cases) {
      const parsed = parse({
        endpoint: 'http://192.0.2.10:8090',
        remote_start: { starter: list, model: 'strata' },
      });
      expect(parsed.success, `${label}: ${issueText(parsed)}`).toBe(false);
      expect(issueText(parsed)).toContain('remote_start.starter');
    }
    // Four is the ceiling, and it is a real one: past four, a laptop that has
    // to walk the whole list has spent four 2.5 s probes on a route that was
    // never going to answer.
    const fourOk = parse({
      endpoint: 'http://192.0.2.10:8090',
      remote_start: { starter: four, model: 'strata' },
    });
    expect(fourOk.success, issueText(fourOk)).toBe(true);
  });

  it('refuses a list in which any address is not an IP literal', () => {
    const cases = [
      ['http://192.0.2.10:8798', 'http://desktop-1.tailnet-xyz.ts:8798'],
      ['http://192.0.2.10:8798', 'https://100.64.0.10:8798'],
      ['http://localhost:8798', 'http://100.64.0.10:8798'],
    ];
    for (const [good, bad] of cases) {
      const parsed = parse({
        endpoint: 'http://192.0.2.10:8090',
        remote_start: { starter: [good, bad], model: 'strata' },
      });
      expect(parsed.success, `${bad}: ${issueText(parsed)}`).toBe(false);
      expect(issueText(parsed)).toContain('must be an http:// URL with an IP host');
    }
  });

  it('refuses an endpoint whose host is not one of the starter hosts', () => {
    // The base URL is rebuilt on the host of the starter that ANSWERED, so an
    // endpoint naming a third machine is not a route this client can take: it
    // would send the chat request to a port the laptop never earned.
    const parsed = parse({
      endpoint: 'http://192.0.2.99:8090',
      remote_start: {
        starter: ['http://192.0.2.10:8798', 'http://100.64.0.10:8798'],
        model: 'strata',
      },
    });
    expect(parsed.success).toBe(false);
    expect(issueText(parsed)).toContain(
      'endpoint host 192.0.2.99 is not one of the remote_start.starter hosts',
    );
  });

  it('refuses a remote_start block that cannot name the desktop model', () => {
    const noName = parse({ remote_start: { starter: 'http://100.64.0.10:8798' } });
    expect(noName.success).toBe(false);
    const emptyName = parse({
      remote_start: { starter: 'http://100.64.0.10:8798', model: '' },
    });
    expect(emptyName.success).toBe(false);
    // strict: a typo like `start:` is refused, not silently ignored — the
    // laptop would otherwise talk to no starter at all.
    const typo = parse({
      remote_start: { starter: 'http://100.64.0.10:8798', model: 'strata', start: 'strata' },
    });
    expect(typo.success).toBe(false);
  });

  it('leaves a model WITHOUT remote_start free to carry the desktop fields', () => {
    // The same entry minus `remote_start` is the desktop's own managed external:
    // these fields are required there, so the rule must not leak onto them.
    const parsed = parse({
      remote_start: undefined,
      unload_path: '/unload',
      start_command: ['start-strata.bat'],
      stop_command: ['stop-strata.bat'],
      stop_on_exit: true,
    });
    expect(parsed.success, issueText(parsed)).toBe(true);
  });

  /**
   * `docs/plans/LAPTOP_FORGE_CONFIG.yaml` is the artifact the owner pastes onto
   * the laptop, so a typo in it is a bug in the feature. Parsed as-is, it must
   * be a valid Forge config — and every desktop entry in it must actually carry
   * `remote_start`, because an entry without it talks to the port in
   * `endpoint` directly, which is exactly the guess this feature removes.
   */
  it('the laptop example config parses as it is, with remote_start on every desktop entry', () => {
    // `docs/plans/` is local-only (gitignored since 2026-10-10), so a clean
    // checkout such as CI has no fixture to read: the check runs on the owner's
    // machine and is skipped rather than failed elsewhere.
    const fixture = path.resolve(
      __dirname,
      '..',
      '..',
      'docs',
      'plans',
      'LAPTOP_FORGE_CONFIG.yaml',
    );
    if (!fs.existsSync(fixture)) return;
    const parsed = ForgeConfigSchema.safeParse(parseYaml(fs.readFileSync(fixture, 'utf8')));
    expect(parsed.success, issueText(parsed)).toBe(true);
    if (!parsed.success) return;

    const desktop = parsed.data.models.filter((entry) => entry.remote_start);
    // 5 Strata/Maya + 12 desktop GGUFs, one entry per GGUF the desktop names.
    expect(desktop).toHaveLength(17);
    // Home LAN first, then Tailscale: the laptop uses whichever answers, and
    // `endpoint` keeps the tailnet host because its host must be one of the
    // starter hosts anyway (see the host check above).
    const pair = starterList(desktop[0]?.remote_start?.starter);
    expect(pair).toHaveLength(2);
    expect(isPrivateLan(urlHost(pair[0]!)), pair[0]).toBe(true);
    expect(isTailscaleRange(urlHost(pair[1]!)), pair[1]).toBe(true);
    for (const entry of desktop) {
      // Every desktop entry dials the same two addresses, in the same order.
      expect(starterList(entry.remote_start?.starter)).toEqual(pair);
      expect(urlHost(entry.endpoint ?? ''), entry.name).toBe(urlHost(pair[1]!));
      // These entries were copied from the desktop, so the two names match;
      // the field is still written out, because it is the DESKTOP's name.
      expect(entry.remote_start?.model).toBe(entry.name);
      expect(entry.unload_path).toBeUndefined();
    }
    // The fixed-slot entry is gone: with `remote_start` the port comes from
    // `/ensure`, so a laptop no longer needs one entry per llama.cpp slot.
    expect(parsed.data.models.some((entry) => entry.name === 'desktop-llama-slot-8080')).toBe(
      false,
    );
    // A laptop with no local models needs no llama.cpp binary.
    expect(parsed.data.llama_server.binary).toBeUndefined();
  });
});
