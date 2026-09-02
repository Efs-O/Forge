import React, { useEffect, useState } from 'react';
import { nextPhrase, phrasePool } from '../statusPhrases';

/**
 * How long each phrase holds before rotating. Deliberately slow: the line sits
 * under the text you are reading, and anything quicker pulls the eye away from
 * it — the opposite of what an ambient indicator is for. Tried at 3.5s and 6s,
 * both too busy.
 */
const ROTATE_MS = 12_000;

/**
 * How often the elapsed counter repaints. Tenths, because at whole seconds a
 * slow first token makes the line look stuck for a second at a time - the exact
 * reading the counter exists to rule out.
 */
const TICK_MS = 100;

interface Props {
  streaming: boolean;
  /** True when the active model runs on the user's own hardware. */
  local: boolean;
  clanker: boolean;
}

/**
 * The single "something is happening" indicator.
 *
 * The row is always mounted, even when idle: it previously appeared and
 * disappeared with the turn, which pushed the composer down at the exact moment
 * text started arriving. It reserves its height and empties instead.
 *
 * The rotation is not decoration. With no spinner glyph, a phrase that changed
 * only per-turn would sit motionless for the length of a cold model load, and a
 * motionless indicator cannot distinguish working from hung.
 */
export function StreamingStatus({ streaming, local, clanker }: Props): React.ReactElement {
  const [phrase, setPhrase] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  // The phrase says something is happening; the clock says for how long. A cold
  // model load and a wedged turn look identical without it.
  useEffect(() => {
    if (!streaming) {
      setElapsedMs(0);
      return;
    }
    const startedAt = Date.now();
    setElapsedMs(0);
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), TICK_MS);
    return () => clearInterval(timer);
  }, [streaming]);

  useEffect(() => {
    if (!streaming) {
      setPhrase(null);
      return;
    }
    const pool = phrasePool({ local, clanker });
    // Picked here rather than during render: every arriving token re-renders
    // this component, and rolling in render would reshuffle the phrase on each
    // one.
    // The bag behind nextPhrase is module-level, so a short turn that draws one
    // phrase leaves the rest of the deck for the next turn.
    setPhrase((current) => nextPhrase(pool, current));
    const timer = setInterval(() => setPhrase((current) => nextPhrase(pool, current)), ROTATE_MS);
    return () => clearInterval(timer);
  }, [streaming, local, clanker]);

  return (
    <div id="streaming-status" className={streaming ? 'is-streaming' : undefined}>
      {/* The rotating text is hidden from assistive tech: announcing a new
          whimsical word every 3.5s for a whole turn would be hostile. The live
          region below states the fact once instead. */}
      <span className="streaming-status-dot" aria-hidden="true" />
      <span className="streaming-status-text" aria-hidden="true">
        {phrase ?? ''}
      </span>
      {streaming && (
        <span className="streaming-status-elapsed" aria-hidden="true">
          {(elapsedMs / 1000).toFixed(1)}s
        </span>
      )}
      <span className="visually-hidden" role="status" aria-live="polite">
        {streaming ? 'Generating' : ''}
      </span>
    </div>
  );
}
