/**
 * The wizard's Q6 extras (`src/sidebar/wizardExtras.ts`): what each pick
 * writes into the fresh config, what it leaves alone, and the sentence the
 * setup toast appends. The leak test matters most — the starter's
 * `permissions` object is one module-level constant shared by every starter,
 * so a mutating `applyWizardExtras` would turn web search on for every install
 * after it in the same process.
 */
import { describe, expect, it } from 'vitest';
import { ForgeConfigSchema } from '../../src/config/schema';
import type { ForgeConfig } from '../../src/config/types';
import { makeLlamaCppStarterConfig } from '../../src/config/StarterConfig';
import {
  applyWizardExtras,
  extrasNextSteps,
  WIZARD_EXTRAS,
  type WizardExtra,
} from '../../src/sidebar/wizardExtras';

const llama = (): ForgeConfig =>
  makeLlamaCppStarterConfig(
    [
      {
        ggufPath: 'C:/models/a.gguf',
        modelName: 'a',
        suggestion: {
          family: 'unknown',
          suggestedName: 'a',
          numCtx: 16384,
          nBatch: 512,
          flashAttn: true,
          temperature: 0.7,
          topP: 0.9,
          topK: 40,
        },
      },
    ],
    'llama-server',
  );

const TELEGRAM_STEPS =
  ' After the reload, run Forge: Set Telegram Bot Token with a token from @BotFather, then Forge: Pair Telegram Remote, then Forge: Set Up Telegram Authenticator.';
const OTHER_COMPUTER_STEPS =
  ' After the reload, run Forge: Connect to my desktop, then Forge: Check connection.';

describe('applyWizardExtras', () => {
  it('web search writes the Step 9 block and permissions.net.search', () => {
    const input = llama();
    const result = applyWizardExtras(input, ['web-search']);
    expect(result.search).toEqual({ provider: 'duckduckgo', max_results: 20 });
    expect(result.permissions?.net?.search).toBe(true);
    // Only the one key changes: fetch was already on and stays on.
    expect(result.permissions?.net?.fetch).toBe(true);
    expect(result.permissions?.approval_timeout_minutes).toBe(
      input.permissions?.approval_timeout_minutes,
    );
  });

  it('never mutates the config it is given, nor the shared starter constant', () => {
    const input = llama();
    const snapshot = structuredClone(input);
    applyWizardExtras(input, ['web-search', 'telegram']);
    expect(input).toEqual(snapshot);
    // `DEFAULT_PERMISSIONS` in StarterConfig.ts is one object every starter
    // gets: a mutation would show up here as search turning on by itself.
    const another = makeLlamaCppStarterConfig(
      [
        {
          ggufPath: 'C:/models/b.gguf',
          modelName: 'b',
          suggestion: {
            family: 'unknown',
            suggestedName: 'b',
            numCtx: 16384,
            nBatch: 512,
            flashAttn: true,
            temperature: 0.7,
            topP: 0.9,
            topK: 40,
          },
        },
      ],
      'llama-server',
    );
    expect(another.permissions?.net?.search).toBe(false);
  });

  it('telegram enables remote and its telegram channel, keeping the rest', () => {
    const input = llama();
    expect(input.remote?.enabled).toBe(false);
    const result = applyWizardExtras(input, ['telegram']);
    expect(result.remote?.enabled).toBe(true);
    expect(result.remote?.telegram.enabled).toBe(true);
    expect(result.remote?.whatsapp).toEqual(input.remote?.whatsapp);
    expect(result.remote?.queue_limit).toBe(input.remote?.queue_limit);
    expect(result.remote?.auth).toEqual(input.remote?.auth);
    // Telegram does not imply web search.
    expect(result.search).toBeUndefined();
  });

  it('other computer and no picks at all leave the config as it was', () => {
    const input = llama();
    expect(applyWizardExtras(input, ['other-computer'])).toEqual(input);
    expect(applyWizardExtras(input, [])).toEqual(input);
  });

  it('a config with both written blocks still passes the whole-config schema', () => {
    // `parse` throws on anything the schema refuses, which is the assertion.
    const parsed = ForgeConfigSchema.parse(
      applyWizardExtras(llama(), ['web-search', 'telegram']),
    );
    expect(parsed.search).toEqual({ provider: 'duckduckgo', max_results: 20 });
    expect(parsed.permissions?.net?.search).toBe(true);
    expect(parsed.remote?.telegram.enabled).toBe(true);
  });
});

describe('extrasNextSteps', () => {
  it('names the commands for telegram and the other computer, in a fixed order', () => {
    expect(extrasNextSteps(['telegram', 'other-computer'])).toBe(
      TELEGRAM_STEPS + OTHER_COMPUTER_STEPS,
    );
    expect(extrasNextSteps(['other-computer', 'telegram'])).toBe(
      TELEGRAM_STEPS + OTHER_COMPUTER_STEPS,
    );
  });

  it('says nothing for web search, and nothing for no picks', () => {
    expect(extrasNextSteps(['web-search'])).toBe('');
    expect(extrasNextSteps([])).toBe('');
  });
});

describe('WIZARD_EXTRAS', () => {
  it('offers the Q6 items the wizard can act on, in the questionnaire order', () => {
    expect(WIZARD_EXTRAS.map((extra) => extra.label)).toEqual([
      'Web search',
      'Telegram',
      'Other computer',
    ]);
    const ids: readonly WizardExtra[] = WIZARD_EXTRAS.map((extra) => extra.id);
    expect(ids).toEqual(['web-search', 'telegram', 'other-computer']);
    for (const extra of WIZARD_EXTRAS) {
      expect(extra.description.length).toBeGreaterThan(0);
    }
  });
});
