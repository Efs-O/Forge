/**
 * Phrases for the streaming status line.
 *
 * Two rules govern what may go in here.
 *
 * 1. **A phrase must be true for the whole turn.** The line shows from the
 *    moment a turn starts, which covers spawning llama-server, reading weights,
 *    prompt processing and generation. Anything asserting one specific activity
 *    ("Reading your files…") is false for most of that window, and anything
 *    asserting progress ("Almost there…") is unknowable.
 * 2. **A phrase must be true for the route.** Local pools talk about the user's
 *    own hardware; a cloud turn touches none of it. Claiming otherwise would
 *    undercut the VRAM signalling the rest of the sidebar does honestly.
 */

/** Local llama.cpp / Ollama: the user's own GPU really is doing the work. */
export const LOCAL_PHRASES = [
  'Burning tokens…',
  'Warming the GPU…',
  'Melting VRAM…',
  'Spinning the fans…',
  'Feeding the GPU…',
  'Thrashing VRAM…',
  'Heating the room…',
  'Cooking silicon…',
  'Roasting the die…',
  'Saturating VRAM…',
  'Pushing watts…',
  'Stressing the rails…',
  'Annoying the GPU…',
  'Draining the PSU…',
  'Torturing the fans…',
  'Something smells burned…',
] as const;

/**
 * Remote routes. Same register, aimed at the rented machine — a generic mood
 * word would read as borrowed from another product, and the local phrases
 * would be a lie. These also quietly reveal a misrouted turn: seeing
 * "Burning credits…" when you meant to run local is a useful surprise.
 */
export const CLOUD_PHRASES = [
  'Burning credits…',
  'Renting a GPU…',
  'Paying per token…',
  'Melting rented VRAM…',
  'Heating a datacenter…',
  'Spending your money…',
  "Someone else's GPU…",
  'Renting silicon…',
  'Billing by the token…',
  'On the meter…',
] as const;

/**
 * Added to whichever pool applies while Clanker Mode is on. Deliberately about
 * the *absence of confirmation*, never about destruction: recursive deletes
 * still confirm, and a joke promising otherwise stops being funny the once
 * somebody believes it.
 */
export const CLANKER_PHRASES = [
  'Clanking…',
  'Full send…',
  'No brakes…',
  'Sending it…',
  'Asking nobody…',
  'Permission? Never…',
  'Unsupervised…',
  'Yeeting…',
] as const;

/**
 * True on any route, because they are about the code rather than the machine.
 * Kept in their own pool instead of duplicated into both: a phrase that drifts
 * between the two copies is exactly the bug nobody notices.
 */
export const SHARED_PHRASES = ['Sloppy coding…', 'No code for you…'] as const;

export interface PhrasePoolOptions {
  /** True when the active model runs on the user's own hardware. */
  local: boolean;
  clanker: boolean;
}

export function phrasePool({ local, clanker }: PhrasePoolOptions): readonly string[] {
  const base = [...(local ? LOCAL_PHRASES : CLOUD_PHRASES), ...SHARED_PHRASES];
  return clanker ? [...base, ...CLANKER_PHRASES] : base;
}

/**
 * A random phrase that is never the one already showing, so a rotation always
 * visibly changes — the rotation is the liveness signal now that the line has
 * no glyph, and repeating the same phrase would read as a hang.
 */
export function nextPhrase(pool: readonly string[], current: string | null): string {
  const candidates = pool.filter((phrase) => phrase !== current);
  const choices = candidates.length > 0 ? candidates : pool;
  return choices[Math.floor(Math.random() * choices.length)] ?? '';
}
