/**
 * Phase B CI check 5(a) (`docs/plans/AGENT_DOCS_GAP_AUDIT_PLAN.md` § "Phase B
 * scope", Claude's review): every top-level config key the schema accepts, plus
 * every key under `permissions:` and `agent_bus:`, must appear in
 * `config/config.example.yaml` — the file a new user copies, and the owner of
 * "User-facing config example" in `docs/OWNERS.md`.
 *
 * Phase A rows this is the teeth for:
 * - U5 / U4: a `permissions:` key that let a model answer an approval card
 *   (`src/config/permissionsSchema.ts`) was in no example and no user-facing
 *   doc, so an owner could not find the setting that turns a stall into a
 *   refusal. That key is gone now, and this check still runs on every key the
 *   schema accepts — which is what keeps the example honest about the rest.
 * - U6: `permissions.chats` (`permissionsSchema.ts:48-60`, defaulted off by
 *   `src/config/StarterConfig.ts:28`) was absent, so a new install's agent
 *   cannot `message_chat action=new` or `steer` and has nothing to read about why.
 * - C6: `config/config.example.yaml:1096-1104` showed 3 of the 13 `agent_bus`
 *   keys and said enabling it only turns on `ask_agent`, when it also opens the
 *   `/agent/*` routes `forge.sh` uses (`src/config/agentBusSchema.ts:5-9`).
 * - S4: `elapsed_time_note` (`src/config/schema.ts:185`) is what `README.md`
 *   names as the gate for `set_checkin`, and the example never showed it.
 *
 * The key set comes from the Zod shapes, not from a typed list, so a key added
 * to the schema fails the example until the example says it exists. A commented
 * line counts as documented: the point is that a reader can find the key and
 * what it does, not that it is switched on. Top-level keys must appear at column
 * 0; nested ones may be indented.
 *
 * Part (b) of check 5 (every key named in a doc must exist in the schema) was
 * dropped by Claude's review; `DocClaimsDrift.test.ts` already parses the
 * example and the README blocks against `ForgeConfigSchema`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ZodOptional, ZodUnknown } from 'zod';
import { describe, expect, it } from 'vitest';
import { AgentBusConfigSchema } from '../../src/config/agentBusSchema';
import { PermissionsSchema } from '../../src/config/permissionsSchema';
import { ForgeConfigSchema } from '../../src/config/schema';

const example = fs.readFileSync(
  path.join(__dirname, '..', '..', 'config', 'config.example.yaml'),
  'utf8',
);

const topLevelKeys = Object.keys(ForgeConfigSchema.shape);
const permissionKeys = Object.keys(PermissionsSchema.unwrap().shape);
const agentBusKeys = Object.keys(AgentBusConfigSchema.unwrap().shape);

/** A key is documented when a line states it, commented or not. */
const mentionsTopLevel = (key: string): boolean =>
  new RegExp(`^#?\\s*${key}\\s*:`, 'mu').test(example);
const mentionsNested = (key: string): boolean =>
  new RegExp(`^\\s*#?\\s*${key}\\s*:`, 'mu').test(example);

/** A key the schema declares as plain `unknown` is a TOMBSTONE for a key Forge
 *  REMOVED: it exists only so the schema can refuse a leftover by name, so the
 *  example config must NOT advertise it as a setting an owner could set. */
const permissionShape = PermissionsSchema.unwrap().shape;
const isTombstone = (key: string): boolean => {
  const field = permissionShape[key];
  return field instanceof ZodOptional && field.unwrap() instanceof ZodUnknown;
};

describe('the example config covers the keys the schema accepts', () => {
  it('has real shapes to compare against', () => {
    expect(topLevelKeys.length).toBeGreaterThan(30);
    expect(permissionKeys).toContain('secret_paths');
    expect(permissionKeys).toContain('chats');
    expect(agentBusKeys).toContain('claude_transport');
    expect(agentBusKeys.length).toBeGreaterThan(10);
  });

  it('shows every top-level key a user could set', () => {
    const missing = topLevelKeys
      .filter((key) => !mentionsTopLevel(key))
      .map((key) => `config.example.yaml has no top-level \`${key}\` line, commented or not`);
    expect(missing).toEqual([]);
  });

  it('shows every permissions key, commented or live', () => {
    const missing = permissionKeys
      .filter((key) => !isTombstone(key))
      .filter((key) => !mentionsNested(key))
      .map((key) => `config.example.yaml never shows \`permissions.${key}\``);
    expect(missing).toEqual([]);
  });

  it('shows every agent_bus key, including the paid relay and the model picks', () => {
    const missing = agentBusKeys
      .filter((key) => !mentionsNested(key))
      .map((key) => `config.example.yaml never shows \`agent_bus.${key}\``);
    expect(missing).toEqual([]);
  });
});
