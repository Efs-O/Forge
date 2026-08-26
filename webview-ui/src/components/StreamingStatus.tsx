import React, { useEffect, useState } from 'react';
import { nextPhrase, phrasePool } from '../statusPhrases';

/** How long each phrase holds before rotating. */
const ROTATE_MS = 3500;

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

  useEffect(() => {
    if (!streaming) {
      setPhrase(null);
      return;
    }
    const pool = phrasePool({ local, clanker });
    // Picked here rather than during render: every arriving token re-renders
    // this component, and rolling in render would reshuffle the phrase on each
    // one.
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
      <span className="visually-hidden" role="status" aria-live="polite">
        {streaming ? 'Generating' : ''}
      </span>
    </div>
  );
}
