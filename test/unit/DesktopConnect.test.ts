/**
 * The pure half of "Forge: Connect to my desktop"
 * (docs/plans/V1_FINISH_PLAN.md lane 3 phase 3.2, acceptance criteria 5 and 6).
 *
 * What is being pinned is the field table from `IMPORT_DESKTOP_MODELS_PLAN.md`
 * plus the two rules that make a bulk write safe on a hand-built config: every
 * `remote: true` model is added without a picking list, and a name that already
 * exists is never touched. The tests also assert what Connect must NEVER write —
 * a key — and that every entry it does write parses with `ForgeConfigSchema`, so
 * a later schema change fails here instead of shipping a laptop config the loader
 * refuses.
 *
 * No file, no fetch and no vscode in this file: `DesktopConnectWrite.test.ts`
 * drives the writes and the desktop reads.
 */
import { describe, it, expect } from 'vitest';
import { ForgeConfigSchema } from '../../src/config/schema';
import type { ForgeConfig, ModelConfig } from '../../src/config/types';
import {
  describeConnectResult,
  parseStarterAddress,
  parseTailnetPeers,
  planConnect,
  relayCandidates,
  starterCandidatesFromConfig,
  type ConnectTargets,
  type DesktopModelRow,
} from '../../src/vscode/desktopConnectPlan';

/** The desktop's `GET /models`, in the shape the starter answers with — one
 *  llama.cpp model, one managed external with a long display name, one with
 *  nothing but a context, one with an unknown capability, and the refusals. */
function desktopModels(): DesktopModelRow[] {
  return [
    {
      name: 'strata-iq3s',
      display_name: 'Qwen Flash-Next (desktop Strata)',
      remote: true,
      context: 262144,
      capabilities: ['tool-call', 'long-context', 'vision'],
      model: 'qwen3.8-flash-next-abliterated-iq3_s',
      token_count: 'count_tokens',
      reasoning_effort: 'xhigh',
    },
    { name: 'gemma-iq3s', remote: true, context: 32768, capabilities: [], token_count: 'tokenize' },
    {
      name: 'maya-m2',
      display_name: 'A display name far longer than the sixty characters the schema allows here',
      remote: true,
      context: 131072,
      capabilities: ['tool-call'],
    },
    { name: 'strata-offacl', remote: true, context: 131072, capabilities: ['bogus'] },
    { name: 'no-context', remote: true, capabilities: [] },
    { name: 'grok', remote: false, reason: 'not_local' },
    { name: 'llama3', remote: false, reason: 'ollama_not_shared' },
    { name: 'claude-code', remote: false },
  ];
}

/** A laptop config, in the shape a real one has: `llama_server` plus the models. */
function laptopConfig(models: ModelConfig[], groups?: Record<string, unknown>): ForgeConfig {
  return {
    models,
    active_model: models[0]?.name ?? 'strata-iq3s',
    llama_server: {},
    ...(groups ? { groups: groups as ForgeConfig['groups'] } : {}),
  } as ForgeConfig;
}

const TARGETS: ConnectTargets = {
  starters: ['http://192.168.1.70:8798', 'http://100.64.0.10:8798'],
  sharedPort: 8798,
  relay: 'http://100.64.0.10:8797',
};

const EMPTY = laptopConfig([]);

/** The plan for the fixture lists, with no existing entries. */
function planFor(models: DesktopModelRow[] = desktopModels(), config = EMPTY) {
  return planConnect(
    models,
    [
      { id: 'grok-code-fast', kind: 'openai' },
      { id: 'llama3:cloud', kind: 'ollama' },
    ],
    config,
    TARGETS,
  );
}

describe('planConnect', () => {
  it('adds every model the desktop will serve, in the desktop order, and no others', () => {
    const plan = planFor();
    expect(plan.entries.map((entry) => entry.name)).toEqual([
      'strata-iq3s',
      'gemma-iq3s',
      'maya-m2',
      'strata-offacl',
      'no-context',
      'grok-code-fast',
      'llama3:cloud',
    ]);
    expect(plan.refused).toEqual([
      { name: 'grok', reason: 'not_local' },
      { name: 'llama3', reason: 'ollama_not_shared' },
      { name: 'claude-code', reason: 'not remotely servable' },
    ]);
    expect(plan.alreadyThere).toEqual([]);
  });

  it('points every entry at the shared port with the desktop name as the path', () => {
    const plan = planFor();
    const strata = plan.entries.find((entry) => entry.name === 'strata-iq3s')!;
    expect(strata.provider).toBe('openai-compatible');
    expect(strata.endpoint).toBe('http://192.168.1.70:8798/strata-iq3s');
    // Written out even when it equals the name: the field exists because the two
    // configs name the same server differently as a rule.
    expect(strata.remote_start).toEqual({
      starter: ['http://192.168.1.70:8798', 'http://100.64.0.10:8798'],
      model: 'strata-iq3s',
    });
    // The same list in every entry, so a laptop that moves networks changes
    // route with nobody editing config.yaml.
    for (const entry of plan.entries.filter((row) => row.remote_start)) {
      expect(entry.remote_start!.starter).toEqual(TARGETS.starters);
    }
    // The endpoint host has to be one of the starter hosts, or the schema
    // refuses the whole config: `validateRemoteStartEntry` says so.
    for (const entry of plan.entries) {
      if (!entry.remote_start) continue;
      expect(new URL(entry.endpoint!).hostname).toContain('192.168.1.70');
    }
  });

  it('every entry it writes parses with ForgeConfigSchema, groups included', () => {
    const plan = planFor();
    const written = laptopConfig(
      [...EMPTY.models, ...plan.entries],
      { ...plan.groups } as Record<string, unknown>,
    );
    const parsed = ForgeConfigSchema.parse(written) as ForgeConfig;
    expect(parsed.models).toHaveLength(plan.entries.length);
    expect(Object.keys(parsed.groups ?? {})).toEqual(['desktop-relay', 'ollama-cloud']);
    // Nothing secret crossed to the laptop: the relay resolves its own tokens.
    for (const entry of parsed.models) {
      expect(entry.api_key_secret).toBeUndefined();
    }
    expect(JSON.stringify(plan.entries)).not.toContain('api_key_secret');
  });

  it('copies the fields the desktop reported and leaves the ones it did not out', () => {
    const plan = planFor();
    const strata = plan.entries.find((entry) => entry.name === 'strata-iq3s')!;
    expect(strata).toMatchObject({
      num_ctx: 262144,
      capabilities: ['tool-call', 'long-context', 'vision'],
      model: 'qwen3.8-flash-next-abliterated-iq3_s',
      token_count: 'count_tokens',
      reasoning_effort: 'xhigh',
      display_name: 'Qwen Flash-Next (desktop Strata)',
    });
    // A display name over the schema's 60-character cap is not silently
    // truncated: it is left out and the note says so.
    const maya = plan.entries.find((entry) => entry.name === 'maya-m2')!;
    expect(maya.display_name).toBeUndefined();
    expect(plan.notes.join(' ')).toMatch(/maya-m2.*60 characters/);
    // No usable context means no `num_ctx`, and the owner has to be told,
    // because the budget maths reads that field.
    const bare = plan.entries.find((entry) => entry.name === 'no-context')!;
    expect(bare.num_ctx).toBeUndefined();
    expect(plan.notes.join(' ')).toMatch(/no-context.*num_ctx is not set/);
  });

  it('does not copy /tokenize, because the shared port does not carry it', () => {
    const plan = planFor();
    const gemma = plan.entries.find((entry) => entry.name === 'gemma-iq3s')!;
    expect(gemma.token_count).toBeUndefined();
    expect(plan.notes.join(' ')).toMatch(/gemma-iq3s.*\/tokenize.*estimated/s);
    // `count_tokens` lives under /v1/, so it does come across.
    expect(plan.entries.find((entry) => entry.name === 'strata-iq3s')!.token_count).toBe(
      'count_tokens',
    );
  });

  it('drops a capability the schema does not know instead of refusing the write', () => {
    const plan = planFor();
    const offacl = plan.entries.find((entry) => entry.name === 'strata-offacl')!;
    // An unknown capability is dropped, not written: an unknown string would fail
    // `ForgeConfigSchema` and refuse the whole run, so one desktop build inventing
    // a capability could not stop the other models landing.
    expect(offacl.capabilities ?? []).toEqual([]);
    // An empty capability list is left out entirely: an empty array would say
    // "this model does nothing", which is not the same as "the desktop said
    // nothing about capabilities".
    expect('capabilities' in offacl).toBe(false);
    expect(plan.entries.map((entry) => entry.name)).toContain('strata-iq3s');
  });

  it('writes cloud models as a name and a group, and creates only missing groups', () => {
    const plan = planFor();
    expect(plan.entries.find((entry) => entry.name === 'grok-code-fast')).toEqual({
      name: 'grok-code-fast',
      group: 'desktop-relay',
    });
    expect(plan.entries.find((entry) => entry.name === 'llama3:cloud')).toEqual({
      name: 'llama3:cloud',
      group: 'ollama-cloud',
    });
    expect(plan.groups['desktop-relay']).toEqual({
      provider: 'openai-compatible',
      endpoint: 'http://100.64.0.10:8797',
    });
    // The Ollama group keeps the think + medium-reasoning defaults the owner's
    // group carries, because a group-only entry gets its behaviour from the group.
    expect(plan.groups['ollama-cloud']).toEqual({
      provider: 'ollama',
      endpoint: 'http://100.64.0.10:8797',
      think: true,
      reasoning_effort: 'medium',
    });
  });

  it('leaves an existing group and an existing entry alone', () => {
    const existing = laptopConfig(
      [{ name: 'grok-code-fast', group: 'desktop-relay' }],
      {
        'desktop-relay': {
          provider: 'openai-compatible',
          endpoint: 'http://100.99.0.99:8797',
        },
      },
    );
    const plan = planConnect(
      [],
      [
        { id: 'grok-code-fast', kind: 'openai' },
        { id: 'llama3:cloud', kind: 'ollama' },
      ],
      existing,
      TARGETS,
    );
    expect(plan.alreadyThere).toEqual(['grok-code-fast']);
    expect(plan.entries.map((entry) => entry.name)).toEqual(['llama3:cloud']);
    // The hand-written group's endpoint is not rewritten: the owner may have
    // pointed it at another machine on purpose.
    expect(Object.keys(plan.groups)).toEqual(['ollama-cloud']);
  });

  it('a second run writes nothing and reports what was already there', () => {
    const first = planFor();
    const after = laptopConfig([...first.entries]);
    const again = planConnect(
      desktopModels(),
      [
        { id: 'grok-code-fast', kind: 'openai' },
        { id: 'llama3:cloud', kind: 'ollama' },
      ],
      after,
      TARGETS,
    );
    expect(again.entries).toEqual([]);
    expect(Object.keys(again.groups)).toEqual([]);
    expect(again.alreadyThere).toHaveLength(7);
    expect(again.refused).toHaveLength(3);
    const message = describeConnectResult(again, { desktopModels: 0, cloudModels: 0 });
    expect(message).toMatch(/7 (were|was) already there and left untouched/);
    expect(message).toMatch(/desktop refuses: grok \(not_local\), llama3 \(ollama_not_shared\)/);
  });

  it('a relay that did not answer still writes the desktop models, and says so', () => {
    const plan = planConnect(desktopModels(), [{ id: 'grok-code-fast', kind: 'openai' }], EMPTY, {
      starters: TARGETS.starters,
      sharedPort: 8798,
      relay: null,
      relayFailure: 'ECONNRESET',
    });
    expect(plan.entries.map((entry) => entry.name)).toEqual([
      'strata-iq3s',
      'gemma-iq3s',
      'maya-m2',
      'strata-offacl',
      'no-context',
    ]);
    expect(Object.keys(plan.groups)).toEqual([]);
    expect(plan.notes.join(' ')).toMatch(/relay did not answer \(ECONNRESET\)/);
    // A desktop whose relay is up but has nothing allowlisted is a different
    // message: nothing was refused, there was simply nothing to add.
    const quiet = planConnect([], [], EMPTY, {
      starters: TARGETS.starters,
      sharedPort: 8798,
      relay: 'http://100.64.0.10:8797',
      relayFailure: null,
    });
    expect(quiet.notes.join(' ')).toBe('');
  });

  it('a desktop that reports no shared port gets no half-written entries', () => {
    const plan = planConnect(desktopModels(), [], EMPTY, {
      starters: TARGETS.starters,
      sharedPort: null,
      relay: 'http://100.64.0.10:8797',
    });
    expect(plan.entries).toEqual([]);
    expect(plan.notAdded.map((row) => row.name)).toEqual([
      'strata-iq3s',
      'gemma-iq3s',
      'maya-m2',
      'strata-offacl',
      'no-context',
    ]);
    expect(plan.notAdded[0]!.why).toMatch(/update Forge on the desktop/);
    expect(describeConnectResult(plan, { desktopModels: 0, cloudModels: 0 })).toMatch(
      /5 models were not added: this desktop does not report a shared port/,
    );
  });
});

describe('choosing the desktop', () => {
  it('uses the addresses this config already carries, in config order, deduped, capped at 4', () => {
    const config = laptopConfig([
      {
        name: 'a',
        provider: 'openai-compatible',
        endpoint: 'http://192.168.1.70:8798/a',
        remote_start: { starter: ['http://192.168.1.70:8798', 'http://100.64.0.10:8798'], model: 'a' },
      },
      {
        name: 'b',
        provider: 'openai-compatible',
        endpoint: 'http://100.64.0.10:8798/b',
        remote_start: {
          starter: ['http://100.64.0.10:8798', 'http://192.168.1.71:8798'],
          model: 'b',
        },
      },
      {
        name: 'c',
        provider: 'openai-compatible',
        endpoint: 'http://192.168.1.72:8798/c',
        remote_start: { starter: 'http://192.168.1.72:8798', model: 'c' },
      },
    ]);
    expect(starterCandidatesFromConfig(config)).toEqual([
      'http://192.168.1.70:8798',
      'http://100.64.0.10:8798',
      'http://192.168.1.71:8798',
      'http://192.168.1.72:8798',
    ]);
    // A one-address list is still a list, and a machine with nothing written yet
    // has no candidates at all — which is what makes Connect ask.
    expect(starterCandidatesFromConfig(EMPTY)).toEqual([]);
  });

  it('offers online tailnet peers by name, and nothing else', () => {
    // The shape `tailscale status --json` really returns (Tailscale 1.104): a
    // `Peer` OBJECT keyed by node key, whose entries name themselves with
    // `DNSName` (trailing dot) and `HostName`, and no `Self` entry for this
    // machine — that is the top-level `Self` object, which this fake carries.
    const json = JSON.stringify({
      Self: { HostName: 'laptop', TailscaleIPs: ['100.64.0.20'] },
      Peer: {
        'nodekey:self': {
          Self: true,
          Online: true,
          HostName: 'laptop',
          DNSName: 'laptop.example-tailnet.ts.net.',
          TailscaleIPs: ['100.64.0.20'],
        },
        'nodekey:a1': {
          HostName: 'DESKTOP-PC',
          DNSName: 'desktop.example-tailnet.ts.net.',
          TailscaleIPs: ['100.64.0.10', 'fd7a:115c:a1e0::1'],
          Online: true,
        },
        'nodekey:b1': {
          HostName: 'STUDIO-OLD',
          DNSName: 'studio.example-tailnet.ts.net.',
          TailscaleIPs: ['100.64.0.8'],
          Online: false,
        },
        'nodekey:c1': {
          HostName: 'SILENT',
          DNSName: 'no-address.example-tailnet.ts.net.',
          TailscaleIPs: [],
          Online: true,
        },
        'nodekey:d1': {
          HostName: 'V6-ONLY',
          DNSName: 'ipv6-only.example-tailnet.ts.net.',
          TailscaleIPs: ['fd7a:115c:a1e0::2'],
          Online: true,
        },
        'nodekey:e1': {
          HostName: 'studio-pc',
          DNSName: '',
          TailscaleIPs: ['100.64.0.9'],
          Online: true,
        },
      },
      Peer2: { 'nodekey:z': { HostName: 'old-shape', TailscaleIPs: ['100.64.0.5'] } },
    });
    expect(parseTailnetPeers(json)).toEqual([
      // An entry marked `Self`, an offline peer and peers with no usable IPv4 are
      // left out, and the `.example-tailnet.ts.net.` suffix is trimmed because
      // two tailnets can name the same machine differently and the owner has to
      // be able to tell them apart. A peer with no `DNSName` falls back to
      // `HostName` rather than disappearing from the picker.
      { name: 'desktop', addresses: ['100.64.0.10'] },
      { name: 'studio-pc', addresses: ['100.64.0.9'] },
    ]);
    // Unparsable or a shape this Tailscale does not produce is an empty list, so
    // the picker falls back to typing rather than pretending to know the tailnet.
    expect(parseTailnetPeers('not json').length).toBe(0);
    expect(parseTailnetPeers(JSON.stringify({ Peer: 'nope' })).length).toBe(0);
    // An ARRAY of peers is the shape older Forge builds read, and the one shape
    // the CLI never writes: reading it back has to be empty, not a guess.
    expect(
      parseTailnetPeers(
        JSON.stringify({
          Peer: [{ HostName: 'desktop', TailscaleIPs: ['100.64.0.10'], Online: true }],
        }),
      ),
    ).toEqual([]);
  });

  it('accepts an address in any form a person would type, and refuses a name', () => {
    expect(parseStarterAddress('100.64.0.10')).toEqual({
      url: 'http://100.64.0.10:8798',
    });
    expect(parseStarterAddress(' http://192.168.1.70:8798 ')).toEqual({
      url: 'http://192.168.1.70:8798',
    });
    expect(parseStarterAddress('192.168.1.70:8801')).toEqual({ url: 'http://192.168.1.70:8801' });
    // An IPv6 tailnet address keeps its brackets in the URL the caller dials:
    // without them `:8798` reads as another label of the address, and the
    // starter's own `new URL` would reject the result.
    expect(parseStarterAddress('http://[fd7a:115c:a1e0::1]:8798')).toEqual({
      url: 'http://[fd7a:115c:a1e0::1]:8798',
    });
    expect(parseStarterAddress('http://[fd7a:115c:a1e0::1]')).toEqual({
      url: 'http://[fd7a:115c:a1e0::1]:8798',
    });
    // A name is refused with the schema's own words, because the starter's Host
    // check would reject it on every later request.
    const named = parseStarterAddress('desktop.tailnet.ts');
    expect('error' in named).toBe(true);
    expect((named as { error: string }).error).toMatch(/IP host/);
    expect('error' in parseStarterAddress('')).toBe(true);
    expect('error' in parseStarterAddress('http://100.64.0.10:99999')).toBe(true);
    expect('error' in parseStarterAddress('https://100.64.0.10:8798')).toBe(true);
  });

  it('tries the relay port this config already uses, then the other addresses', () => {
    const config = laptopConfig([
      { name: 'grok-code-fast', group: 'desktop-relay' },
      {
        name: 'a',
        provider: 'openai-compatible',
        endpoint: 'http://100.64.0.10:8791',
        remote_start: { starter: ['http://100.64.0.10:8798'], model: 'a' },
      },
      { name: 'cloud', provider: 'openai-compatible', endpoint: 'http://100.64.0.10:8791' },
      { name: 'other', provider: 'openai-compatible', endpoint: 'http://100.64.0.20:8797' },
    ]);
    const candidates = ['http://100.64.0.10:8798', 'http://192.168.1.70:8798'];
    expect(relayCandidates(config, candidates[0]!, candidates)).toEqual([
      // The port the laptop is already dialing for its cloud entries comes first
      // on the host that answered, because an existing entry is using it.
      'http://100.64.0.10:8791',
      'http://100.64.0.10:8797',
      'http://192.168.1.70:8791',
      'http://192.168.1.70:8797',
    ]);
  });
});
