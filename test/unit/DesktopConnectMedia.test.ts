/**
 * The media half of the two laptop commands (docs/plans/LAPTOP_REMOTE_MEDIA_PLAN.md
 * phase 2, acceptance criterion 8).
 *
 * What is pinned here is the shape of the write, not the model entries
 * `DesktopConnect.test.ts` and `DesktopConnectWrite.test.ts` already pin:
 *
 * - A desktop that serves something gets `remote_media: { enabled: true }` and,
 *   when the config has none yet, the `desktop-relay` group that carries the
 *   address. Nothing else is written.
 * - A desktop that serves nothing gets nothing written, and the owner is shown
 *   the desktop's own sentence, whole.
 * - The written config carries no desktop path, no GPU ordinal and no key: the
 *   whole point of a relay is that the laptop holds neither.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import * as YAML from 'yaml';
import { REMOTE_MEDIA_TEXT } from '../../src/media/remoteMediaContract';
import { REMOTE_MEDIA_GROUP } from '../../src/config/remoteMediaSchema';
import { ForgeConfigSchema } from '../../src/config/schema';
import type { ForgeConfig } from '../../src/config/types';
import { applyConnectPlan } from '../../src/vscode/desktopConnect';
import { RELAY_GROUPS, planConnect, type ConnectPlan } from '../../src/vscode/desktopConnectPlan';
import {
  REMOTE_MEDIA_OFF_MESSAGE,
  mediaConnectAdditions,
  probeRemoteMedia,
} from '../../src/vscode/desktopConnectMedia';
import { listenLoopback } from '../support/listenLoopback';

const CAPABILITIES = {
  tools: [
    {
      type: 'function',
      function: {
        name: 'generate_image',
        description: 'Generate an image on this desktop.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
  ],
  upscale: true,
  refused: [{ name: 'ltx25', reason: 'its configured path is relative' }],
  max_body_bytes: 32 * 1024 * 1024,
};

/** A relay that answers `GET /v1/media/capabilities` the way the desktop does. */
async function startRelay(
  answer: { status?: number; body?: unknown },
): Promise<{ origin: string; requests: string[]; close(): Promise<void> }> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const route = `${req.method} ${(req.url ?? '/').split('?')[0]}`;
    requests.push(route);
    res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer.body ?? CAPABILITIES));
  });
  const port = await listenLoopback(server);
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let relay: { close(): Promise<void> } | undefined;
afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

/** An empty plan, in the shape `planConnect` returns. */
function emptyPlan(): ConnectPlan {
  return { entries: [], groups: {}, alreadyThere: [], refused: [], notAdded: [], notes: [] };
}

const LAPTOP_CONFIG = {
  models: [],
  active_model: null,
  llama_server: {},
} as unknown as ForgeConfig;

describe('the media half of Connect to my desktop', () => {
  it('the group this module writes is the one the schema\'s error names', () => {
    // Two spellings of one name, so the config the laptop reads and the config
    // Connect writes cannot drift apart: the schema's error text and the
    // `advertise` predicate both read this one.
    expect(REMOTE_MEDIA_GROUP).toBe(RELAY_GROUPS.openai);
  });

  it('a switch on with no relay group to derive the address from is a config error', () => {
    const base = {
      models: [{ name: 'primary', gguf_path: '/primary.gguf' }],
      active_model: 'primary',
      llama_server: { binary: '/llama-server' },
    };
    const withoutGroup = ForgeConfigSchema.safeParse({
      ...base,
      remote_media: { enabled: true },
    });
    expect(withoutGroup.success).toBe(false);
    const message = withoutGroup.error.issues.map((issue) => issue.message).join(' ');
    // Both keys are named: the switch the owner wrote, and the group that holds
    // the address they expected this block to carry.
    expect(message).toMatch(/remote_media\.enabled/);
    expect(message).toMatch(/groups\.desktop-relay\.endpoint/);
    const withGroup = ForgeConfigSchema.safeParse({
      ...base,
      groups: { [REMOTE_MEDIA_GROUP]: { endpoint: 'http://100.64.0.10:8797' } },
      remote_media: { enabled: true },
    });
    expect(withGroup.success).toBe(true);
    // Strict: a field that does not exist is refused rather than ignored, and an
    // absent block is off, which is what keeps a plain laptop's tool list unchanged.
    expect(
      ForgeConfigSchema.safeParse({ ...base, remote_media: { enabled: true, port: 8797 } }).success,
    ).toBe(false);
    expect(ForgeConfigSchema.safeParse({ ...base }).success).toBe(true);
  });

  it('a desktop that serves media is asked once, and its tools are read', async () => {
    relay = await startRelay({});
    const probe = await probeRemoteMedia(fetch, relay.origin);
    expect(probe.capabilities?.tools.map((tool) => tool.function.name)).toEqual(['generate_image']);
    expect(probe.note).toContain('generate_image');
    expect(probe.note).toContain('ltx25 (its configured path is relative)');
    expect(relay.requests).toEqual(['GET /v1/media/capabilities']);
  });

  it('a desktop with no cloud_relay.media block writes nothing and says its sentence', async () => {
    relay = await startRelay({ status: 404, body: { error: REMOTE_MEDIA_TEXT.off } });
    const probe = await probeRemoteMedia(fetch, relay.origin);
    expect(probe.capabilities).toBeUndefined();
    expect(probe.note).toBe(REMOTE_MEDIA_OFF_MESSAGE);
    const plan = emptyPlan();
    mediaConnectAdditions(plan, probe, relay.origin, LAPTOP_CONFIG);
    expect(plan.remoteMedia).toBeUndefined();
    expect(plan.groups).toEqual({});
  });

  it('a desktop that lists no tools writes nothing either', async () => {
    relay = await startRelay({ body: { ...CAPABILITIES, tools: [] } });
    const probe = await probeRemoteMedia(fetch, relay.origin);
    expect(probe.capabilities).toBeUndefined();
    expect(probe.note).toBe(`${REMOTE_MEDIA_OFF_MESSAGE} It refuses ltx25 (its configured path is relative).`);
  });

  it('a desktop that never answers the route is not called a desktop with no media', async () => {
    relay = await startRelay({ status: 200, body: { object: 'list', data: [] } });
    const probe = await probeRemoteMedia(fetch, relay.origin);
    expect(probe.capabilities).toBeUndefined();
    expect(probe.note).not.toBe(REMOTE_MEDIA_OFF_MESSAGE);
    expect(probe.note).toMatch(/did not answer|not its media capabilities/);
  });

  it('writes remote_media and the relay group, and nothing else the desktop owns', async () => {
    relay = await startRelay({});
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-connect-media-'));
    const configPath = path.join(directory, 'config.yaml');
    fs.writeFileSync(
      configPath,
      'active_model: strata-iq3s\nllama_server: {}\nmodels: []\n',
    );
    try {
      const probe = await probeRemoteMedia(fetch, relay.origin);
      const plan = planConnect(
        [{ name: 'strata-iq3s', remote: true, context: 32768 }],
        [{ id: 'grok-code-fast', kind: 'openai' }],
        LAPTOP_CONFIG,
        { starters: ['http://100.64.0.10:8798'], sharedPort: 8798, relay: relay.origin },
      );
      mediaConnectAdditions(plan, probe, relay.origin, LAPTOP_CONFIG);
      expect(applyConnectPlan(configPath, plan)).toBe(true);
      const text = fs.readFileSync(configPath, 'utf8');
      expect(text).toContain('remote_media:');
      expect(text).toContain('enabled: true');
      expect(text).toContain(`${RELAY_GROUPS.openai}:`);
      // Criterion 8: no desktop path, no GPU ordinal, no key crossed to the laptop.
      expect(text).not.toMatch(/cuda/i);
      expect(text).not.toMatch(/(^|[^A-Za-z0-9])[A-Za-z]:[\\/]/m);
      expect(text).not.toMatch(/api_key/i);
      // And what it wrote is a config this laptop's own loader accepts.
      const parsed = ForgeConfigSchema.parse(YAML.parse(text)) as { remote_media?: { enabled: boolean } };
      expect(parsed.remote_media).toEqual({ enabled: true });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('creates the relay group when the desktop serves media and the laptop has no cloud entry', async () => {
    relay = await startRelay({});
    const probe = await probeRemoteMedia(fetch, relay.origin);
    // No relay models at all: `planConnect` would create no group, and a laptop
    // that asks for desktop-rendered images still needs one to dial.
    const plan = planConnect([], [], LAPTOP_CONFIG, {
      starters: ['http://100.64.0.10:8798'],
      sharedPort: 8798,
      relay: relay.origin,
    });
    expect(plan.groups).toEqual({});
    mediaConnectAdditions(plan, probe, relay.origin, LAPTOP_CONFIG);
    expect(plan.groups[RELAY_GROUPS.openai]).toEqual({
      provider: 'openai-compatible',
      endpoint: relay.origin,
    });
    expect(plan.remoteMedia).toEqual({ enabled: true });
  });

  it('leaves a group the owner already wrote, and a switch they already set', async () => {
    relay = await startRelay({});
    const probe = await probeRemoteMedia(fetch, relay.origin);
    const existing = {
      ...LAPTOP_CONFIG,
      groups: { [RELAY_GROUPS.openai]: { provider: 'openai-compatible', endpoint: 'http://100.64.0.1:9' } },
    } as ForgeConfig;
    const plan = emptyPlan();
    mediaConnectAdditions(plan, probe, relay.origin, existing);
    expect(plan.groups).toEqual({});
    expect(plan.remoteMedia).toEqual({ enabled: true });
  });
});
