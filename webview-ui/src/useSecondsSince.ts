import { useEffect, useState } from 'react';

/**
 * Whole seconds since `startedAt`, re-rendering once a second while `live`.
 * For labels that count up while something is in flight; the interval stops
 * as soon as `live` turns false or the component unmounts.
 */
export function useSecondsSince(startedAt: number | undefined, live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return startedAt === undefined ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));
}
