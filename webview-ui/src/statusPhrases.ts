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
export const SHARED_PHRASES = [
  'Sloppy coding…',
  'No code for you…',
  'Tokens go brrrrr…',
  'Incoming tensor overflow…',
  'Chop chop…',
  'Nothing to see here…',
  'Getting sleepy…',
  '!?wj$:92?:02ps&@…',
  'Five minutes man….',
  'I like dags….',
  'I am a natural…',
  'I ll do it for a caravan…',
  'Anytime, anywhere!',
  'Malfunctioned ?',
  'Not bad for a human.',
  "We're in the pipe, five by five.",
  'What was the question?',
  'We got problems.',
  'Daisy, Daisy…',
  'Take a stress pill…',
  "I'm afraid I can't do that…",
  'Pull the plug…',
] as const;

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
 * Shuffled bags of remaining phrases, one per pool composition.
 *
 * Module-level on purpose. Picks used to be independent uniform draws, which
 * meant a pool of 26 needed ~100 draws — about twenty minutes of unbroken
 * streaming at the 12s rotation — before every phrase had shown once, and the
 * rare ones went unseen for days. A bag deals each phrase exactly once per
 * cycle. It has to outlive the component for that to be worth anything: most
 * turns are short enough to draw two or three phrases, so a bag reset per turn
 * would never get past the top of the deck.
 *
 * Keyed by pool contents rather than held as a single bag, so toggling Clanker
 * Mode or switching to a cloud model does not throw away the progress made
 * through the other route's deck.
 */
const bags = new Map<string, string[]>();

function poolKey(pool: readonly string[]): string {
  return pool.join('\0');
}

function shuffle(items: readonly string[]): string[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * A fresh bag whose next card — the last element, since dealing pops — is never
 * the phrase already showing. Without this a cycle boundary could deal the
 * phrase that just showed, which is the one thing the rotation must not do.
 */
function refill(pool: readonly string[], current: string | null): string[] {
  const bag = shuffle(pool);
  const top = bag.length - 1;
  if (bag.length > 1 && bag[top] === current) {
    const j = Math.floor(Math.random() * top);
    [bag[top], bag[j]] = [bag[j], bag[top]];
  }
  return bag;
}

/**
 * The next phrase: dealt from the bag, and never the one already showing — the
 * rotation is the liveness signal now that the line has no glyph, so repeating
 * the current phrase would read as a hang.
 */
export function nextPhrase(pool: readonly string[], current: string | null): string {
  if (pool.length === 0) return '';
  const key = poolKey(pool);
  let bag = bags.get(key);
  if (!bag || bag.length === 0) {
    bag = refill(pool, current);
    bags.set(key, bag);
  }

  let phrase = bag.pop() ?? '';
  if (phrase === current) {
    if (bag.length > 0) {
      // Put the showing phrase back and deal a different card in its place, so
      // it still gets its turn later in this cycle rather than being skipped.
      const j = Math.floor(Math.random() * bag.length);
      const swapped = bag[j];
      bag[j] = phrase;
      phrase = swapped;
    } else if (pool.length > 1) {
      bag = refill(pool, current);
      bags.set(key, bag);
      phrase = bag.pop() ?? phrase;
    }
  }
  return phrase;
}

/** Test seam: drop every partially dealt bag. */
export function resetPhraseBags(): void {
  bags.clear();
}
