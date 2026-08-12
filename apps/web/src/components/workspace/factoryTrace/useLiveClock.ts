// FILE: useLiveClock.ts
// Purpose: A once-a-second clock for surfaces whose numbers grow while a session is live.
// Layer: Workspace UI
//
// Shared so the lanes and the session strip advance on the same tick: two clocks
// running independently would show a block's duration and the run's duration
// disagreeing by a second, which reads as a bug in the numbers.

import { useEffect, useState } from "react";

/**
 * The current time, re-read every second while `active`.
 *
 * When inactive it holds its last value rather than reading the wall clock on
 * every render, so a finished session stops invalidating memos.
 */
export function useLiveClock(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);

  return nowMs;
}
