/**
 * The optional extras the fallback first-run wizard offers after the trust
 * switches: Q6 of `docs/plans/FIRST_RUN_QUESTIONNAIRE.md`, in its order and
 * words. "Daily chat retitle" is not here yet — it needs a job created after
 * the reload, which this wizard cannot do before one.
 *
 * `search` and `remote` are policy keys: an agent's `edit_file` is refused on
 * them (`src/config/policySchema.ts`, `ownerPaths.ts`), so the setup agent can
 * only show the owner the YAML to paste. The wizard is the owner's own UI, so
 * it writes those blocks itself.
 *
 * No `vscode` import: the module is data plus plain object copies, so
 * `test/unit/WizardExtras.test.ts` runs it without an extension host.
 */
import { RemoteConfigSchema } from '../config/remoteSchema';
import type { ForgeConfig } from '../config/types';

export type WizardExtra = 'web-search' | 'telegram' | 'other-computer';

/** Q6 of FIRST_RUN_QUESTIONNAIRE.md, in its order and words. */
export const WIZARD_EXTRAS: ReadonlyArray<{
  id: WizardExtra;
  label: string;
  description: string;
}> = [
  { id: 'web-search', label: 'Web search', description: 'DuckDuckGo, no key, no account.' },
  {
    id: 'telegram',
    label: 'Telegram',
    description: 'Chat with Forge from your phone, through your own @BotFather bot.',
  },
  {
    id: 'other-computer',
    label: 'Other computer',
    description: 'Use models from your other computer over Tailscale; connect after the reload.',
  },
];

/**
 * `permissions.net.search: true` and the Step 9 `search` block, copying every
 * object on the path. The copy is not ceremony: the starter's `permissions` is
 * one module-level constant shared by every starter (`DEFAULT_PERMISSIONS` in
 * `src/config/StarterConfig.ts`), so a mutation here would turn search on for
 * every later starter built in the same process.
 */
function withWebSearch(config: ForgeConfig): ForgeConfig {
  return {
    ...config,
    search: { provider: 'duckduckgo', max_results: 20 },
    permissions: {
      ...config.permissions,
      net: { ...config.permissions?.net, search: true },
    },
  };
}

/** Remote's schema defaults for a config that has no `remote` block: the same
 *  shape `StarterConfig.ts` writes, `wake_relay` kept only when it is set. */
function starterRemote(): NonNullable<ForgeConfig['remote']> {
  const { wake_relay, ...remote } = RemoteConfigSchema.unwrap().parse({});
  return wake_relay ? { ...remote, wake_relay } : remote;
}

/** `remote.enabled` and `remote.telegram.enabled: true`; every other `remote`
 *  field (queue limits, auth, attachments, contacts) is carried over as it was. */
function withTelegram(config: ForgeConfig): ForgeConfig {
  const remote = config.remote ?? starterRemote();
  return {
    ...config,
    remote: {
      ...remote,
      enabled: true,
      telegram: { ...remote.telegram, enabled: true },
    },
  };
}

/**
 * The config with the picked extras turned on. Never mutates `config`.
 * `other-computer` changes nothing: **Forge: Connect to my desktop** adds the
 * other machine's models after the reload, so there is no block to guess here.
 */
export function applyWizardExtras(config: ForgeConfig, picks: readonly WizardExtra[]): ForgeConfig {
  let next = config;
  if (picks.includes('web-search')) next = withWebSearch(next);
  if (picks.includes('telegram')) next = withTelegram(next);
  return next;
}

/** What the user does after the reload, per extra. Web search needs nothing,
 *  so it adds nothing; the command titles are the ones `AI_SETUP.md` Steps 8
 *  and 12 use (`forge.remote.setTelegramToken`, `forge.remote.pairTelegram`,
 *  `forge.remote.setupTelegramTotp`, `forge.connectDesktop`,
 *  `forge.checkConnection`). */
const NEXT_STEPS: Record<WizardExtra, string> = {
  'web-search': '',
  telegram:
    ' After the reload, run Forge: Set Telegram Bot Token with a token from @BotFather, then Forge: Pair Telegram Remote, then Forge: Set Up Telegram Authenticator.',
  'other-computer':
    ' After the reload, run Forge: Connect to my desktop, then Forge: Check connection.',
};

/**
 * The sentence the setup toast appends. The order is the table's, not the
 * caller's, so the same set of extras always reads the same; nothing picked
 * gives the empty string.
 */
export function extrasNextSteps(picks: readonly WizardExtra[]): string {
  return WIZARD_EXTRAS.filter((extra) => picks.includes(extra.id))
    .map((extra) => NEXT_STEPS[extra.id])
    .join('');
}
