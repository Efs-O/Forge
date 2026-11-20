/**
 * The chat that walks the post-wizard steps only the human can do.
 *
 * Two of the wizard's Q6 extras end in work no code can finish: Telegram needs
 * @BotFather, a pairing code typed into a bot and an authenticator; the other
 * computer needs a Tailscale sign-in on each machine. The wizard cannot walk
 * them, because it runs with **no config loaded** — there is no model to answer
 * and no chat to answer in. So the wizard leaves a one-shot marker in
 * `context.globalState`, and the next activation — which by definition has a
 * loaded config and a sidebar host — consumes it and opens one chat.
 *
 * No `vscode` import: the memento and host slices this needs are declared as
 * interfaces, so `test/unit/LocalSetupChat.test.ts` runs the whole thing
 * without an extension host.
 */
import type { WizardExtra } from './wizardExtras';
import type { ForgeHostFacade } from './ForgeHostFacade';

/** The `globalState` key holding the one-shot marker. */
export const PENDING_LOCAL_SETUP_KEY = 'forge.firstRun.pendingLocalSetup';

/** The extras whose steps are human-only. */
export type LocalSetupExtra = 'telegram' | 'other-computer';

/** The slice of `vscode.Memento` this module uses. */
export interface SetupMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/** The two ids, in `WIZARD_EXTRAS` order, so every list this module produces
 *  and every seed it builds reads the same whatever order the picks came in. */
const LOCAL_SETUP_IDS: readonly LocalSetupExtra[] = ['telegram', 'other-computer'];

const isLocalSetupExtra = (value: unknown): value is LocalSetupExtra =>
  value === 'telegram' || value === 'other-computer';

/** The picks that need the chat, in `WIZARD_EXTRAS` order: `'telegram'`,
 *  `'other-computer'`. Web search needs nothing after the reload, so it never
 *  opens one. */
export function localSetupExtras(picks: readonly WizardExtra[]): LocalSetupExtra[] {
  return LOCAL_SETUP_IDS.filter((id) => picks.includes(id));
}

/** Leave the marker when any picked extra has human-only steps; otherwise do
 *  nothing at all — no `update` call, so a plain setup leaves nothing behind. */
export async function markPendingLocalSetup(
  state: SetupMemento,
  picks: readonly WizardExtra[],
): Promise<void> {
  const extras = localSetupExtras(picks);
  if (extras.length === 0) return;
  await state.update(PENDING_LOCAL_SETUP_KEY, { extras });
}

const INTRO =
  'I just set up Forge with its setup wizard. Help me finish the steps only I can do, one step at a time: tell me the next step, then wait for me to say it is done before the next one. Do not edit any Forge config file: the wizard already wrote it, and the commands below store the secrets. Never ask me to paste a token or a code into this chat.\n';

const TELEGRAM =
  '\nTelegram:\n' +
  '1. In Telegram, open @BotFather, send /newbot, and follow its questions. It answers with a bot token.\n' +
  '2. In VS Code, run Forge: Set Telegram Bot Token from the Command Palette and paste the token there.\n' +
  '3. Run Forge: Pair Telegram Remote and send the code it shows to my new bot.\n' +
  '4. Run Forge: Set Up Telegram Authenticator and add it to an authenticator app.\n' +
  '5. Send my bot a message from my phone and check that Forge answers.\n';

const OTHER =
  '\nOther computer:\n' +
  '1. Install Tailscale on both computers and sign in to the same account on each.\n' +
  '2. Run Forge: Connect to my desktop from the Command Palette, then Forge: Check connection.\n' +
  '3. If the check reports a problem, help me read it. You may run tailscale status to look.\n';

const OUTRO = '\nStart with the first step.';

/** The chat's first message: the intro, then each picked extra's steps in this
 *  module's order, then the closing line. */
export function localSetupSeed(extras: ReadonlyArray<LocalSetupExtra>): string {
  return (
    INTRO +
    (extras.includes('telegram') ? TELEGRAM : '') +
    (extras.includes('other-computer') ? OTHER : '') +
    OUTRO
  );
}

/** The marker's extras when it names at least one real extra; duplicates are
 *  collapsed. `undefined` for anything else, including a non-object. */
function markerExtras(marker: unknown): LocalSetupExtra[] | undefined {
  if (typeof marker !== 'object' || marker === null || Array.isArray(marker)) return undefined;
  const raw = (marker as { extras?: unknown }).extras;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  if (!raw.every(isLocalSetupExtra)) return undefined;
  return LOCAL_SETUP_IDS.filter((id) => (raw as unknown[]).includes(id));
}

/**
 * Consume the marker: clear it first, then open one chat and send the seed.
 *
 * The clear comes before anything else on purpose — if opening or sending
 * throws, the marker is already gone, so a host that cannot open a chat does
 * not spawn a new one on every start. `createConversation` and `send` errors
 * propagate: the caller shows them. Returns the new conversation id, or
 * `undefined` when there was no (valid) marker.
 */
export async function openPendingLocalSetup(
  state: SetupMemento,
  host: Pick<ForgeHostFacade, 'createConversation' | 'send'>,
): Promise<string | undefined> {
  const marker = state.get<unknown>(PENDING_LOCAL_SETUP_KEY);
  if (marker === undefined) return undefined;
  await state.update(PENDING_LOCAL_SETUP_KEY, undefined);
  const extras = markerExtras(marker);
  if (!extras) return undefined;
  const conv = await host.createConversation({ activate: true });
  await host.send(conv.id, localSetupSeed(extras));
  return conv.id;
}
